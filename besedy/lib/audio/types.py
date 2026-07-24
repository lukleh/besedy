"""Data types and constants for audio processing.

This module contains:
- Dataclasses for representing conversion results
- ManifestWriter for thread-safe CSV output
- Constants for audio processing (tolerances, normalization targets)
- Utility functions (format_size, detect_logical_cpus)
"""

from __future__ import annotations

import csv
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from besedy.core.paths import FFMPEG_LOG_DIR
from besedy.core.system import detect_logical_cpus
from besedy.lib.audio.quality import AUDIO_QUALITY_COLUMNS, AudioQualityMetrics

__all__ = [
    "AUDIO_QUALITY_COLUMNS",
    "CONVERSION_LOG_DIR",
    "DECLIP_THRESHOLD_DBTP",
    "ConversionLogMessage",
    "ConversionResult",
    "DURATION_TOLERANCE_MIN_SECONDS",
    "DURATION_TOLERANCE_PERCENTAGE",
    "FILESIZE_MISMATCH_DRIFT_TOLERANCE",
    "LOUDNESS_ACCEPTABLE_MAX_LUFS",
    "LOUDNESS_ACCEPTABLE_MIN_LUFS",
    "LOUDNESS_RANGE_LU",
    "LOUDNESS_TARGET_LUFS",
    "ManifestWriter",
    "NON_MONOTONIC_MAX_RATIO",
    "NON_MONOTONIC_MIN_RATIO",
    "PreparedEntry",
    "STAGED_AUDIO_EXTENSION",
    "STAGE_AUDIO_AUTO",
    "SYMLINK_ELIGIBLE_EXTENSION",
    "SkippedEntry",
    "TARGET_CHANNELS",
    "TRUE_PEAK_TARGET_DBTP",
    "detect_logical_cpus",
    "format_size",
]


def _get_iso8601_timestamp() -> str:
    """Return current UTC time in ISO 8601 format with Z suffix.

    Local copy to avoid circular import with manager.py.
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# =============================================================================
# Audio Format Constants
# =============================================================================
TARGET_CHANNELS = 1
STAGED_AUDIO_EXTENSION = ".wav"
SYMLINK_ELIGIBLE_EXTENSION = STAGED_AUDIO_EXTENSION
CONVERSION_LOG_DIR = FFMPEG_LOG_DIR
STAGE_AUDIO_AUTO = "__AUTO_STAGE_DIR__"

# =============================================================================
# Duration Validation Tolerances
# =============================================================================
# WHY 0.25s: Minimum absolute tolerance for very short clips (<12.5s).
# For files shorter than 12.5 seconds, 2% tolerance is less than 0.25s,
# so we use 0.25s as a floor to avoid false positives from rounding.
DURATION_TOLERANCE_MIN_SECONDS = 0.25

# WHY 2%: Relative tolerance for longer files where fixed tolerance is too strict.
# Audio encoding/decoding can introduce small timing variations; 2% accounts
# for normal codec behavior without accepting gross errors.
DURATION_TOLERANCE_PERCENTAGE = 0.02

# WHY 10%: Container formats (MP4, MKV, WebM) often have inaccurate duration
# metadata vs actual audio stream length. When FFmpeg warns "filesize and
# duration do not match", accept up to 10% drift before failing.
FILESIZE_MISMATCH_DRIFT_TOLERANCE = 0.10

# WHY 0.5-2.5 range: Non-monotonic DTS (decoding timestamps) warnings indicate
# corrupted/disordered timestamps in the container, NOT actual audio corruption.
# The audio data is intact; FFmpeg just misreports duration. Accept 50%-250%
# of expected duration when this warning appears.
NON_MONOTONIC_MIN_RATIO = 0.5
NON_MONOTONIC_MAX_RATIO = 2.5

# =============================================================================
# Loudness Normalization (EBU R128 Broadcast Standard)
# =============================================================================
# WHY -16 LUFS: EBU R128 target for broadcast speech. Optimal for intelligibility
# and listening comfort across devices. Lower than music (-14 LUFS) because
# speech has narrower dynamic range and benefits from headroom.
LOUDNESS_TARGET_LUFS = -16

# WHY 11 LU: Loudness Range preserves natural speech dynamics. Too low (< 8 LU)
# sounds compressed/flat; too high (> 15 LU) causes volume jumping.
LOUDNESS_RANGE_LU = 11

# WHY -1.5 dBTP: True peak limit with 0.5 dB headroom below 0 dBFS. Prevents
# inter-sample peaks from causing clipping on playback. EBU R128 recommends -1 dBTP.
TRUE_PEAK_TARGET_DBTP = -1.5

# WHY -20 to -12 LUFS: ±4 LUFS tolerance around -16 target. Linear normalization
# preserves dynamics but can't always hit exact target without compression.
# Files outside this range trigger compression retry (linear=false).
LOUDNESS_ACCEPTABLE_MIN_LUFS = -20
LOUDNESS_ACCEPTABLE_MAX_LUFS = -12

# WHY -1.0 dBTP: EBU R128 maximum true peak threshold for broadcast compliance.
# Peaks >= -1.0 dBTP indicate clipped samples that degrade speech quality.
# Audio above this threshold triggers declipping filter.
DECLIP_THRESHOLD_DBTP = -1.0


@dataclass(frozen=True)
class PreparedEntry:
    """Represents a successfully staged audio file.

    Attributes:
        sha256: Audio content hash (SHA-256 of decoded PCM at 16kHz mono).
                Field name kept for backward compatibility.
        source: Path to the original audio file.
        staged: Path to the staged/converted audio file.
        action: How the file was staged ("symlink", "convert", or "existing").
        duration_seconds: Duration of the audio in seconds.
        normalized: Whether loudness normalization was applied.
    """

    sha256: str  # Actually audio content hash (kept for backward compat)
    source: Path
    staged: Path
    action: str  # "symlink", "convert", or "existing"
    duration_seconds: float
    normalized: bool = False


@dataclass(frozen=True)
class SkippedEntry:
    """Represents an audio file that was skipped during staging.

    Attributes:
        sha256: Audio content hash (SHA-256 of decoded PCM at 16kHz mono).
                Field name kept for backward compatibility.
        source: Path to the original audio file.
        reason: Why the file was skipped.
    """

    sha256: str  # Actually audio content hash (kept for backward compat)
    source: Path
    reason: str


@dataclass(frozen=True)
class ConversionLogMessage:
    """A single log message from the conversion process.

    Attributes:
        text: The message text.
        is_error: Whether this is an error message (affects coloring).
    """

    text: str
    is_error: bool = False


@dataclass(frozen=True)
class ConversionResult:
    """Result of converting/staging a single audio file.

    Attributes:
        prepared: Successfully staged entry, or None if failed.
        skipped: Skipped entry with reason, or None if successful.
        messages: Log messages generated during conversion.
        log_lines: Lines to write to the conversion log file.
        metrics: Audio quality metrics if analysis was performed.
        size_bytes: Size of the output file in bytes.
    """

    prepared: PreparedEntry | None
    skipped: SkippedEntry | None
    messages: Sequence[ConversionLogMessage]
    log_lines: Sequence[str]
    metrics: AudioQualityMetrics | None = None
    size_bytes: int = 0


class ManifestWriter:
    """Thread-safe CSV writer that records staged artifacts as they complete.

    Writes a CSV file with staged file information and optional audio
    quality metrics. Safe for concurrent writes from multiple threads.

    Attributes:
        include_analysis: Whether to include audio analysis columns.
        fieldnames: Column names for the CSV file.
    """

    def __init__(self, path: Path, include_analysis: bool) -> None:
        """Initialize the manifest writer.

        Args:
            path: Path to the output CSV file.
            include_analysis: Whether to include audio analysis columns.
        """
        self.include_analysis = include_analysis
        self.lock = threading.Lock()
        fieldnames = ["Hash", "Full Path", "Filename", "Size (bytes)", "Size (human)", "added_at"]
        if include_analysis:
            fieldnames.extend(AUDIO_QUALITY_COLUMNS)
        self.fieldnames = fieldnames
        path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = path.open("w", newline="", encoding="utf-8")
        self.writer = csv.DictWriter(self.handle, fieldnames=fieldnames, quoting=csv.QUOTE_MINIMAL)
        self.writer.writeheader()
        self.handle.flush()

    def write_entry(
        self,
        entry: PreparedEntry,
        *,
        size_bytes: int,
        metrics: AudioQualityMetrics | None = None,
        added_at: str | None = None,
    ) -> None:
        """Write a staged file entry to the manifest.

        Args:
            entry: The prepared entry to write.
            size_bytes: Size of the staged file in bytes.
            metrics: Optional audio quality metrics.
            added_at: ISO 8601 timestamp when entry was added. Defaults to current time.
        """
        row = {
            "Hash": entry.sha256,
            "Full Path": str(entry.staged),
            "Filename": entry.staged.name,
            "Size (bytes)": size_bytes,
            "Size (human)": format_size(size_bytes),
            "added_at": added_at or _get_iso8601_timestamp(),
        }
        if self.include_analysis:
            for column in AUDIO_QUALITY_COLUMNS:
                row[column] = getattr(metrics, column, "") if metrics else ""
        with self.lock:
            self.writer.writerow(row)
            self.handle.flush()

    def close(self) -> None:
        """Close the manifest file."""
        with self.lock:
            self.handle.close()


def format_size(num_bytes: int) -> str:
    """Format a byte count as a human-readable string.

    Args:
        num_bytes: Number of bytes.

    Returns:
        Human-readable size string (e.g., "1.5 MB").
    """
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    value = float(max(0, num_bytes))
    for unit in units:
        if value < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{num_bytes} B"
