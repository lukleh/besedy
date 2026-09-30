"""Audio archive command - compress audio to Opus/WebM or M4A with EBU R128 normalization.

Opus archives also get an AAC-in-MP4 copy by default, encoded from the same
decoded source with the same loudness measurement. iOS Safari loads a WebM
file whole into its GPU process instead of streaming it, which fails for
multi-hour recordings; the MP4 copy streams with range requests.

Ownership note:
- keep catalog-manifest coordination, output layout, and CLI-facing reporting here
- keep reusable audio-analysis and codec primitives in `besedy.lib.audio.*`
"""

from __future__ import annotations

import argparse
import csv
import fcntl
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

from rich.console import Console
from rich.markup import escape as rich_escape
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

from besedy.commands.catalog.archive_ffmpeg import (
    analyze_loudness,
    build_m4a_command,
    build_opus_command,
    check_encoder_available,
    nearest_opus_sample_rate,
    probe_input_bitrate,
    probe_input_sample_rate,
)
from besedy.commands.catalog.csv_utils import load_audio_rows, resolve_catalog_csv
from besedy.commands.catalog.default_paths import (
    get_default_archived_symlink,
    get_default_loudness_symlink,
)
from besedy.commands.catalog.metadata import format_duration
from besedy.commands.catalog.symlink import (
    create_or_update_symlink,
    validate_symlink_can_be_created,
)
from besedy.core.paths import (
    extract_timestamp_from_archived_catalog,
    extract_timestamp_from_loudness_catalog,
    resolve_audio_artifacts_root,
)
from besedy.lib.audio.decode import decode_to_temp_wav
from besedy.lib.audio.quality import needs_declipping
from besedy.lib.audio.types import (
    DECLIP_THRESHOLD_DBTP,
    detect_logical_cpus,
    format_size,
)
from besedy.lib.data.atomic_io import atomic_path
from besedy.lib.workflow.common import CsvAudioRow

# =============================================================================
# Constants
# =============================================================================

# Compression presets optimized for speech (tested on 7-hour recordings)
# At 32kbps Opus with voip mode, speech remains intelligible with 50% size reduction
OPUS_BITRATES: dict[str, int] = {"low": 32, "medium": 48, "high": 64, "max": 96}
M4A_VBR_MODES: dict[str, int] = {"low": 2, "medium": 3, "high": 4, "max": 5}

# Super-wideband sample rate - optimal for speech (captures 0-12 kHz)
# 24 kHz is sufficient for full speech quality; 48 kHz offers no benefit for voice
ARCHIVE_SAMPLE_RATE = 24000

# Opus encoder supported sample rates for speech archiving
# Keep this constant exported for tests/documentation even though the rounding
# helper now lives in archive_ffmpeg.py.
OPUS_SUPPORTED_RATES = [8000, 12000, 16000, 24000]

# File extensions by format
FORMAT_EXTENSIONS: dict[str, str] = {"opus": ".webm", "m4a": ".m4a"}

# The AAC copy of an Opus archive sits next to it with this extension.
AAC_COPY_EXTENSION = ".m4a"
AAC_COPY_PATH_COLUMN = "Compressed AAC Path"


# =============================================================================
# Dataclasses
# =============================================================================


@dataclass(frozen=True)
class CompressedEntry:
    """Successfully compressed audio file."""

    sha256: str
    source: Path
    compressed: Path
    format: str  # "opus" or "m4a"
    bitrate_kbps: int
    source_size_bytes: int
    compressed_size_bytes: int
    compression_ratio: float
    duration_seconds: float
    added_at: str | None = None  # ISO 8601 timestamp when record was added
    aac_path: Path | None = None  # AAC-in-MP4 copy of an Opus archive
    aac_size_bytes: int | None = None
    aac_bitrate_kbps: int | None = None


@dataclass(frozen=True)
class ArchiveSkippedEntry:
    """Audio file that was skipped during archival."""

    sha256: str
    source: Path
    reason: str


@dataclass(frozen=True)
class CompressionResult:
    """Result of compressing a single audio file."""

    compressed: CompressedEntry | None
    skipped: ArchiveSkippedEntry | None
    # The Opus archive succeeded but its AAC copy did not; the row is written
    # with blank AAC columns so `--backfill-aac` can add the copy later.
    warning: str | None = None


@dataclass
class ArchiveRequest:
    csv: Path | None = None
    output_dir: Path | None = None
    format: str = "opus"
    quality: str = "low"
    bitrate: int | None = None
    stereo: bool = False
    limit: int | None = None
    continue_on_error: bool = False
    overwrite: bool = False
    parallel: int | None = None
    ffmpeg_binary: Path | str = Path("ffmpeg")
    ffprobe_binary: Path | str = Path("ffprobe")
    no_symlink: bool = False
    # Write an AAC-in-MP4 copy next to each Opus archive (ignored for m4a).
    aac_copy: bool = True
    # Only add the AAC copy to rows already in the archived manifest.
    backfill_aac: bool = False

    @classmethod
    def from_args(
        cls,
        args: argparse.Namespace | "ArchiveRequest",
    ) -> "ArchiveRequest":
        if isinstance(args, cls):
            return args
        return cls(
            csv=getattr(args, "csv", None),
            output_dir=getattr(args, "output_dir", None),
            format=getattr(args, "format", "opus"),
            quality=getattr(args, "quality", "low"),
            bitrate=getattr(args, "bitrate", None),
            stereo=bool(getattr(args, "stereo", False)),
            limit=getattr(args, "limit", None),
            continue_on_error=bool(getattr(args, "continue_on_error", False)),
            overwrite=bool(getattr(args, "overwrite", False)),
            parallel=getattr(args, "parallel", None),
            ffmpeg_binary=getattr(args, "ffmpeg_binary", Path("ffmpeg")),
            ffprobe_binary=getattr(args, "ffprobe_binary", Path("ffprobe")),
            no_symlink=bool(getattr(args, "no_symlink", False)),
            aac_copy=not bool(getattr(args, "no_aac", False)),
            backfill_aac=bool(getattr(args, "backfill_aac", False)),
        )


# =============================================================================
# Manifest Writer
# =============================================================================


class ArchivedManifestWriter:
    """Thread-safe CSV writer for archived audio manifest."""

    FIELDNAMES = [
        "Hash",
        "Original Path",
        "Compressed Path",
        "Format",
        "Bitrate (kbps)",
        "Original Size (bytes)",
        "Compressed Size (bytes)",
        "Compression Ratio",
        "Duration",
        "added_at",
        AAC_COPY_PATH_COLUMN,
        "Compressed AAC Size (bytes)",
        "Compressed AAC Bitrate (kbps)",
    ]

    def __init__(self, path: Path, append: bool = False) -> None:
        """Initialize the manifest writer.

        Args:
            path: Path to the CSV file.
            append: If True and file exists, append without writing header.
                A manifest written before the AAC columns existed is first
                rewritten with the current header, so appended rows line up.
        """
        self.lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)

        if append and path.exists():
            self.fieldnames = migrate_manifest_header(path)
            self.handle = path.open("a", newline="", encoding="utf-8")
            self.writer = csv.DictWriter(
                self.handle, fieldnames=self.fieldnames, quoting=csv.QUOTE_MINIMAL
            )
            # Don't write header in append mode
        else:
            self.fieldnames = list(self.FIELDNAMES)
            self.handle = path.open("w", newline="", encoding="utf-8")
            self.writer = csv.DictWriter(
                self.handle, fieldnames=self.fieldnames, quoting=csv.QUOTE_MINIMAL
            )
            self.writer.writeheader()
        self.handle.flush()

    def write_entry(self, entry: CompressedEntry) -> None:
        """Write a compressed file entry to the manifest."""
        with self.lock:
            self.writer.writerow(manifest_row(entry))
            self.handle.flush()

    def close(self) -> None:
        """Close the manifest file."""
        with self.lock:
            self.handle.close()


def manifest_row(entry: CompressedEntry) -> dict[str, str | int]:
    """The manifest columns for one archived file."""
    return {
        "Hash": entry.sha256,
        "Original Path": str(entry.source),
        "Compressed Path": str(entry.compressed),
        "Format": entry.format,
        "Bitrate (kbps)": entry.bitrate_kbps,
        "Original Size (bytes)": entry.source_size_bytes,
        "Compressed Size (bytes)": entry.compressed_size_bytes,
        "Compression Ratio": f"{entry.compression_ratio:.1f}",
        "Duration": format_duration(entry.duration_seconds),
        "added_at": entry.added_at or "",
        **aac_manifest_values(entry.aac_path, entry.aac_size_bytes, entry.aac_bitrate_kbps),
    }


def aac_manifest_values(
    aac_path: Path | None, size_bytes: int | None, bitrate_kbps: int | None
) -> dict[str, str | int]:
    """The AAC-copy columns; empty when there is no copy."""
    return {
        AAC_COPY_PATH_COLUMN: str(aac_path) if aac_path else "",
        "Compressed AAC Size (bytes)": size_bytes if size_bytes is not None else "",
        "Compressed AAC Bitrate (kbps)": bitrate_kbps if bitrate_kbps is not None else "",
    }


def _read_manifest(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return list(reader.fieldnames or []), list(reader)


def _write_manifest_atomically(
    path: Path, fieldnames: list[str], rows: Iterable[dict[str, str]]
) -> None:
    # atomic_path keeps the file mode, writes through a symlinked manifest to
    # its target, and fsyncs before the rename.
    with atomic_path(path) as temp:
        with temp.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, quoting=csv.QUOTE_MINIMAL)
            writer.writeheader()
            for row in rows:
                writer.writerow({name: row.get(name, "") for name in fieldnames})


def _manifest_fieldnames(existing: list[str]) -> list[str]:
    # Keep any column the file already has, in order, and add missing ones.
    return existing + [name for name in ArchivedManifestWriter.FIELDNAMES if name not in existing]


def migrate_manifest_header(path: Path) -> list[str]:
    """Give an existing manifest every current column; return its header.

    Rows keep their values, and new columns start empty. The file is only
    rewritten when a column is missing.
    """
    existing, rows = _read_manifest(path)
    fieldnames = _manifest_fieldnames(existing)
    if fieldnames != existing:
        _write_manifest_atomically(path, fieldnames, rows)
    return fieldnames


def update_manifest_rows(path: Path, updates: dict[str, dict[str, str | int]]) -> int:
    """Set columns on manifest rows by hash, atomically; return rows changed."""
    existing, rows = _read_manifest(path)
    fieldnames = _manifest_fieldnames(existing)
    changed = 0
    for row in rows:
        values = updates.get((row.get("Hash") or "").strip())
        if values:
            row.update({name: str(value) for name, value in values.items()})
            changed += 1
    _write_manifest_atomically(path, fieldnames, rows)
    return changed


# =============================================================================
# Core Compression Logic
# =============================================================================


@dataclass(frozen=True)
class PreparedSource:
    """Everything both encoders need from one source, computed once."""

    temp_wav: Path
    measured: dict[str, str]
    apply_declipping: bool
    input_bitrate: int | None
    capped_sample_rate: int


def prepare_source(
    row: CsvAudioRow,
    source: Path,
    *,
    ffmpeg_binary: str,
    ffprobe_binary: str,
) -> tuple[PreparedSource | None, str | None]:
    """Probe, measure and decode a source to a temp WAV.

    The caller owns ``temp_wav`` and must delete it. On failure returns
    ``(None, reason)`` and leaves no temp file behind.
    """
    # Probe input bitrate and sample rate for capping (never upconvert)
    input_bitrate = probe_input_bitrate(source, ffprobe_binary)
    input_sample_rate = probe_input_sample_rate(source, ffprobe_binary)

    # Cap sample rate: don't upsample low-quality sources
    capped_sample_rate = min(input_sample_rate or ARCHIVE_SAMPLE_RATE, ARCHIVE_SAMPLE_RATE)

    # Get loudness data (use pre-computed if available, else analyze)
    if row.integrated_loudness_lufs and row.true_peak_db and row.loudness_range_lu:
        # Use pre-computed loudness from catalog (skip first-pass analysis)
        measured = {
            "input_i": row.integrated_loudness_lufs,
            "input_lra": row.loudness_range_lu,
            "input_tp": row.true_peak_db,
            "input_thresh": row.input_thresh or "-70.0",
            "target_offset": row.target_offset or "0.0",
        }
    else:
        # Fall back to first-pass analysis
        analyzed, error = analyze_loudness(source, ffmpeg_binary)
        if error:
            return None, error
        assert analyzed is not None
        measured = analyzed

    # Determine if declipping is needed (same logic as stage-audio)
    # Use true_peak from measured data to detect clipping
    apply_declipping = needs_declipping(measured.get("input_tp"), threshold=DECLIP_THRESHOLD_DBTP)

    # Decode source to temp WAV (handles corruption gracefully)
    # This prevents loudnorm filter issues with corrupted MP3 frames that cause
    # audio loss at the end of files.
    temp_fd, temp_path_str = tempfile.mkstemp(suffix=".wav", prefix="archive_")
    temp_wav = Path(temp_path_str)
    # Close the file descriptor - decode_to_temp_wav will write to the path
    os.close(temp_fd)
    ok, decode_error = decode_to_temp_wav(source, temp_wav, ffmpeg_binary=ffmpeg_binary)
    if not ok:
        temp_wav.unlink(missing_ok=True)
        return None, f"decode failed: {decode_error}"

    return (
        PreparedSource(
            temp_wav=temp_wav,
            measured=measured,
            apply_declipping=apply_declipping,
            input_bitrate=input_bitrate,
            capped_sample_rate=capped_sample_rate,
        ),
        None,
    )


def aac_vbr_mode(quality: str, input_bitrate: int | None) -> int:
    """VBR mode for the quality preset, capped to the source (never upconvert)."""
    vbr_mode = M4A_VBR_MODES[quality]
    # VBR 3 ≈ 48-56 kbps, VBR 4 ≈ 64-72 kbps, VBR 5 ≈ 96-112 kbps
    if input_bitrate:
        if input_bitrate < 50:
            vbr_mode = min(vbr_mode, 3)
        elif input_bitrate < 80:
            vbr_mode = min(vbr_mode, 4)
    return vbr_mode


def aac_quality_for_opus_bitrate(opus_kbps: int) -> str:
    """The quality preset whose Opus bitrate is closest to ``opus_kbps``.

    The AAC copy follows the Opus archive's actual bitrate, including a
    custom ``--bitrate`` or an older archive's preset.
    """
    # A tie (40 kbps between low and medium) goes up: AAC-LC needs more bits
    # than Opus for the same speech quality.
    return min(
        OPUS_BITRATES,
        key=lambda preset: (abs(OPUS_BITRATES[preset] - opus_kbps), -OPUS_BITRATES[preset]),
    )


def _run_ffmpeg(cmd: list[str], output_path: Path) -> str | None:
    """Run an encode; on failure remove partial output and return the reason."""
    try:
        result = subprocess.run(cmd, capture_output=True)
    except Exception as exc:
        output_path.unlink(missing_ok=True)
        return f"compression failed: {exc}"
    if result.returncode != 0:
        output_path.unlink(missing_ok=True)
        stderr = result.stderr.decode("utf-8", errors="replace")
        return f"ffmpeg failed: {stderr[:200]}"
    return None


def _encode_m4a(
    prepared: PreparedSource,
    output_path: Path,
    *,
    quality: str,
    stereo: bool,
    ffmpeg_binary: str,
    use_fdk: bool,
) -> tuple[int, str | None]:
    """Encode AAC in MP4 from the prepared source; return (VBR mode, error)."""
    vbr_mode = aac_vbr_mode(quality, prepared.input_bitrate)
    # M4A/AAC supports any sample rate, use capped rate directly
    cmd = build_m4a_command(
        prepared.temp_wav,
        output_path,
        prepared.measured,
        vbr_mode,
        prepared.capped_sample_rate,
        stereo,
        ffmpeg_binary,
        use_fdk,
        apply_declipping=prepared.apply_declipping,
    )
    return vbr_mode, _run_ffmpeg(cmd, output_path)


def _measured_kbps(size_bytes: int, duration_seconds: float) -> int | None:
    if duration_seconds <= 0:
        return None
    return round(size_bytes * 8 / duration_seconds / 1000)


def compress_audio_file(
    row: CsvAudioRow,
    output_path: Path,
    *,
    format: str,
    quality: str,
    stereo: bool,
    ffmpeg_binary: str,
    ffprobe_binary: str,
    use_fdk: bool,
    force: bool = False,
    bitrate_override: int | None = None,
    aac_output_path: Path | None = None,
) -> CompressionResult:
    """Compress a single audio file with two-pass normalization.

    With ``aac_output_path`` (Opus only), also encode an AAC-in-MP4 copy from
    the same decoded source. If only the copy fails, the Opus archive is kept
    and the result carries a warning; its AAC columns stay blank.
    """
    source = Path(row.full_path)
    sha256 = row.sha256

    # Check source exists
    if not source.exists():
        return CompressionResult(
            compressed=None,
            skipped=ArchiveSkippedEntry(sha256, source, "source file not found"),
        )

    # Check if output already exists
    if output_path.exists():
        if not force:
            return CompressionResult(
                compressed=None,
                skipped=ArchiveSkippedEntry(sha256, source, "output already exists"),
            )
        # Force mode: delete existing file and reprocess
        output_path.unlink()

    # Create output directory
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Get source size
    source_size = source.stat().st_size

    prepared, error = prepare_source(
        row, source, ffmpeg_binary=ffmpeg_binary, ffprobe_binary=ffprobe_binary
    )
    if prepared is None:
        return CompressionResult(
            compressed=None, skipped=ArchiveSkippedEntry(sha256, source, error or "")
        )

    duration = row.duration_seconds if row.duration_seconds else 0.0
    aac_size: int | None = None
    aac_warning: str | None = None
    try:
        # Normalize and compress (second pass) - using temp WAV as input
        if format == "opus":
            target_bitrate = bitrate_override if bitrate_override else OPUS_BITRATES[quality]
            # Cap bitrate to input (never upconvert)
            if prepared.input_bitrate and prepared.input_bitrate < target_bitrate:
                effective_bitrate = prepared.input_bitrate
            else:
                effective_bitrate = target_bitrate
            # Opus requires specific sample rates - round to nearest supported
            effective_sample_rate = nearest_opus_sample_rate(prepared.capped_sample_rate)
            cmd = build_opus_command(
                prepared.temp_wav,  # Use temp WAV instead of original source
                output_path,
                prepared.measured,
                effective_bitrate,
                effective_sample_rate,
                stereo,
                ffmpeg_binary,
                apply_declipping=prepared.apply_declipping,
            )
            error = _run_ffmpeg(cmd, output_path)
        else:  # m4a
            vbr_mode, error = _encode_m4a(
                prepared,
                output_path,
                quality=quality,
                stereo=stereo,
                ffmpeg_binary=ffmpeg_binary,
                use_fdk=use_fdk,
            )
            # Approximate bitrate for M4A VBR
            effective_bitrate = {2: 40, 3: 52, 4: 68, 5: 104}.get(vbr_mode, 68)

        if error is None and format == "opus" and aac_output_path is not None:
            aac_output_path.unlink(missing_ok=True)
            aac_output_path.parent.mkdir(parents=True, exist_ok=True)
            _, aac_error = _encode_m4a(
                prepared,
                aac_output_path,
                quality=aac_quality_for_opus_bitrate(effective_bitrate),
                stereo=stereo,
                ffmpeg_binary=ffmpeg_binary,
                use_fdk=use_fdk,
            )
            if aac_error:
                # Keep the Opus archive: the recording stays playable
                # everywhere but Safari, and a later --backfill-aac retries
                # only the copy.
                aac_warning = f"aac copy {aac_error}"
            else:
                aac_size = aac_output_path.stat().st_size
    finally:
        # Always clean up temp WAV file
        prepared.temp_wav.unlink(missing_ok=True)

    if error:
        return CompressionResult(
            compressed=None, skipped=ArchiveSkippedEntry(sha256, source, error)
        )

    # Get output size and calculate ratio
    compressed_size = output_path.stat().st_size
    ratio = source_size / compressed_size if compressed_size > 0 else 0

    has_aac = aac_size is not None
    return CompressionResult(
        compressed=CompressedEntry(
            sha256=sha256,
            source=source,
            compressed=output_path,
            format=format,
            bitrate_kbps=effective_bitrate,
            source_size_bytes=source_size,
            compressed_size_bytes=compressed_size,
            compression_ratio=ratio,
            duration_seconds=duration,
            added_at=row.added_at,
            aac_path=aac_output_path if has_aac else None,
            aac_size_bytes=aac_size,
            aac_bitrate_kbps=_measured_kbps(aac_size, duration) if aac_size is not None else None,
        ),
        skipped=None,
        warning=aac_warning,
    )


@dataclass(frozen=True)
class AacBackfillResult:
    """Outcome of adding the AAC copy to one already archived row."""

    sha256: str
    values: dict[str, str | int] | None
    skipped: ArchiveSkippedEntry | None


def backfill_aac_copy(
    row: CsvAudioRow,
    compressed_path: Path,
    opus_kbps: int,
    *,
    stereo: bool,
    ffmpeg_binary: str,
    ffprobe_binary: str,
    use_fdk: bool,
) -> AacBackfillResult:
    """Encode the AAC copy for an existing Opus archive, next to it.

    Uses the same source, loudness values and declip decision as a fresh
    archive, and the quality preset closest to the archive's Opus bitrate.
    """
    source = Path(row.full_path)
    sha256 = row.sha256
    if not source.exists():
        return AacBackfillResult(
            sha256, None, ArchiveSkippedEntry(sha256, source, "source file not found")
        )
    aac_path = compressed_path.with_suffix(AAC_COPY_EXTENSION)
    prepared, error = prepare_source(
        row, source, ffmpeg_binary=ffmpeg_binary, ffprobe_binary=ffprobe_binary
    )
    if prepared is None:
        return AacBackfillResult(sha256, None, ArchiveSkippedEntry(sha256, source, error or ""))
    try:
        aac_path.unlink(missing_ok=True)
        _, error = _encode_m4a(
            prepared,
            aac_path,
            quality=aac_quality_for_opus_bitrate(opus_kbps),
            stereo=stereo,
            ffmpeg_binary=ffmpeg_binary,
            use_fdk=use_fdk,
        )
    finally:
        prepared.temp_wav.unlink(missing_ok=True)
    if error:
        return AacBackfillResult(
            sha256, None, ArchiveSkippedEntry(sha256, source, f"aac copy {error}")
        )
    size = aac_path.stat().st_size
    duration = row.duration_seconds or 0.0
    return AacBackfillResult(
        sha256, aac_manifest_values(aac_path, size, _measured_kbps(size, duration)), None
    )


# =============================================================================
# Archive CSV Helpers
# =============================================================================


def compute_common_source_root(rows: list[CsvAudioRow]) -> Path:
    """Find the common root directory of all source files.

    Example:
        /path/to/Besedy/folder1/file1.mp3
        /path/to/Besedy/folder2/file2.mp3
        → common root: /path/to/Besedy
    """
    # Use parent directories (not file paths) so single-file catalogs resolve
    # to the containing folder instead of the file itself.
    parents = [Path(row.full_path).resolve().parent for row in rows]
    return Path(os.path.commonpath(parents))


def load_archived_hashes(csv_path: Path) -> set[str]:
    """Load audio content hashes that have already been archived.

    Args:
        csv_path: Path to the archived CSV file.

    Returns:
        Set of audio hashes from the CSV (empty if the file does not exist
        or has no header).

    Raises:
        ValueError: If the file exists but cannot be read, or its header has
            no 'Hash' column. Treating it as empty would truncate it and
            re-encode every recording.
    """
    hashes: set[str] = set()
    try:
        with csv_path.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            if reader.fieldnames is not None and "Hash" not in reader.fieldnames:
                raise ValueError(
                    f"Archived CSV {csv_path} has no 'Hash' column "
                    f"(found: {list(reader.fieldnames)})"
                )
            for row in reader:
                hash_value = (row.get("Hash") or "").strip()
                if hash_value:
                    hashes.add(hash_value)
    except FileNotFoundError:
        return hashes
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        raise ValueError(f"Cannot read archived CSV {csv_path}: {exc}") from exc

    return hashes


# Keep old name for backward compatibility
load_archived_sha256s = load_archived_hashes


def infer_output_dir_from_archived_csv(csv_path: Path) -> tuple[Path | None, str | None]:
    """Infer output directory from archived CSV filename and audio_artifacts_root.

    Uses the timestamp from the CSV name to construct the archive directory path.
    Falls back to finding common root of compressed paths if that fails.

    Args:
        csv_path: Path to the archived CSV file.

    Returns:
        Tuple of (output_dir, error_message). If successful, error is None.
    """
    if not csv_path.exists():
        return None, None

    # Try to extract timestamp from CSV name and construct path
    # CSV name pattern: audio_catalog_YYYYMMDD_HHMMSS_loudness_archived.csv
    timestamp = extract_timestamp_from_archived_catalog(csv_path)
    if timestamp:
        artifacts_root = resolve_audio_artifacts_root()
        output_dir = artifacts_root / f"audio_archived_{timestamp}"
        if output_dir.exists():
            return output_dir, None

    # Fallback: find common root from compressed paths (handles edge cases)
    try:
        compressed_paths: list[Path] = []
        with csv_path.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                compressed = row.get("Compressed Path", "").strip()
                if compressed:
                    compressed_paths.append(Path(compressed))

        if not compressed_paths:
            return None, f"No compressed paths found in {csv_path}"

        # Find common root of all compressed paths (use parent dirs to avoid files)
        parent_dirs = [p.parent for p in compressed_paths]
        common = Path(os.path.commonpath([str(p) for p in parent_dirs]))

        return common, None

    except Exception as exc:
        return None, f"Failed to read archived CSV {csv_path}: {exc}"


def compute_output_path(
    source_path: Path,
    source_root: Path,
    output_dir: Path,
    extension: str,
    sha256: str,
) -> Path:
    """Compute output path relative to common source root with hash suffix.

    Args:
        source_path: Absolute path to the source file.
        source_root: Common root directory of all source files.
        output_dir: Directory where compressed files will be stored.
        extension: File extension for the output file (e.g., ".webm").
        sha256: Content hash of the source file (first 8 chars used in filename).

    Returns:
        Output path preserving directory structure relative to source_root,
        with 8-character hash suffix to prevent filename collisions.

    Example:
        source_path: /mnt/data/Besedy/folder/file.mp3
        source_root: /mnt/data/Besedy
        output_dir:  /mnt/data/Besedy-archive
        sha256:      2cb6f452b62cb491...
        → output:    /mnt/data/Besedy-archive/folder/file_2cb6f452.webm
    """
    source_abs = source_path.resolve()
    relative = source_abs.relative_to(source_root)
    if relative == Path("."):
        # Defensive fallback: if source_root unexpectedly equals source file,
        # keep output as a file under output_dir.
        relative = Path(source_abs.name)
    output_base = output_dir / relative
    # Add 8-char hash suffix to prevent collisions from same-name files
    new_name = f"{output_base.stem}_{sha256[:8]}{extension}"
    return output_base.parent / new_name


# =============================================================================
# Parser Registration
# =============================================================================


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'archive' subparser."""
    from pathlib import Path

    parser = subparsers.add_parser(
        "archive",
        help="Compress audio for archival (up to 90%% space savings)",
        description="""\
Creates space-efficient archived copies using modern codecs:
  opus (default)  Best compression for speech, WebM container, plus an
                  AAC-in-MP4 copy for iOS Safari (skip with --no-aac)
  m4a             AAC codec, better compatibility

Includes EBU R128 loudness normalization for consistent playback volume.

Example:
  catalog archive                              # Default: opus, low quality
  catalog archive --format m4a --quality high  # AAC for music
  catalog archive --bitrate 48                 # Custom bitrate
  catalog archive --backfill-aac               # Add AAC copies to an existing archive
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Source catalog CSV. Default: audio_catalog_loudness.csv (uses pre-computed loudness to skip first-pass analysis).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Directory for compressed audio files. Default: <audio_artifacts_root>/audio_archived_<timestamp>/.",
    )
    parser.add_argument(
        "--format",
        choices=["opus", "m4a"],
        default="opus",
        help="Output codec. opus: best compression for speech (WebM container). m4a: wider compatibility (AAC codec).",
    )
    parser.add_argument(
        "--quality",
        choices=["low", "medium", "high", "max"],
        default="low",
        help="Quality preset. For speech recordings: 'low' (32kbps) is sufficient. For music or archival: 'high' or 'max'. Bitrates: low=32, medium=48, high=64, max=96 kbps.",
    )
    parser.add_argument(
        "--bitrate",
        type=int,
        default=None,
        help="Custom bitrate in kbps. Overrides --quality. Common values: 32 (speech), 64 (high-quality speech), 96+ (music).",
    )
    parser.add_argument(
        "--stereo",
        action="store_true",
        help="Preserve stereo channels. By default, converts to mono (halves file size, fine for speech).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Process only first N files. Useful for testing or processing in batches.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Skip problematic files instead of aborting the entire run.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing output files. Useful for re-processing partial or corrupted files.",
    )
    parser.add_argument(
        "--parallel",
        type=int,
        default=None,
        help="Parallel compression workers. Default: half of CPU cores.",
    )
    parser.add_argument(
        "--ffmpeg-binary",
        type=Path,
        default=Path("ffmpeg"),
        help="Path to ffmpeg executable.",
    )
    parser.add_argument(
        "--ffprobe-binary",
        type=Path,
        default=Path("ffprobe"),
        help="Path to ffprobe executable (for bitrate detection).",
    )
    parser.add_argument(
        "--no-symlink",
        action="store_true",
        help="Do not create or update symlinks (archived catalog/audio).",
    )
    parser.add_argument(
        "--no-aac",
        action="store_true",
        help="Opus only: do not write the AAC-in-MP4 copy next to each archive.",
    )
    parser.add_argument(
        "--backfill-aac",
        action="store_true",
        help=(
            "Add the AAC-in-MP4 copy to Opus rows already in the archived manifest "
            "that lack one, encoding from the same source, then update the manifest. "
            "With --overwrite, re-encode existing copies too."
        ),
    )
    parser.set_defaults(func=handle_archive)
    return parser


# =============================================================================
# Main Handler
# =============================================================================


@contextmanager
def catalog_ingest_lock(archived_csv_path: Path) -> Iterator[None]:
    """Hold the catalog's ingest lock, the one the upload flow takes.

    Admin uploads run `run-pipeline` under `<catalogs>/.ingest-<id>.lock`
    (besedy/lib/prefect_jobs/flows/ingest_recording.py), which appends to the
    archived manifest. The backfill rewrites that manifest, so it waits for
    the lock instead of racing an upload. The pipeline's own archive step does
    not take it: it already runs under it.
    """
    catalog_id = extract_timestamp_from_archived_catalog(archived_csv_path.resolve())
    if not catalog_id:
        yield
        return
    lock_path = archived_csv_path.parent / f".ingest-{catalog_id}.lock"
    with lock_path.open("a+") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def select_aac_encoder(ffmpeg_binary: str) -> bool:
    """True when libfdk_aac is available; otherwise the built-in encoder is used."""
    if check_encoder_available(ffmpeg_binary, "libfdk_aac"):
        print("Using libfdk_aac encoder for AAC")
        return True
    print("Note: libfdk_aac not available, using built-in AAC encoder")
    return False


def run_aac_backfill(
    request: ArchiveRequest,
    rows: list[CsvAudioRow],
    archived_csv_path: Path,
) -> int:
    """Add the AAC copy to already archived Opus rows, updating the manifest.

    Each copy is written next to its WebM from the row's source in the
    loudness catalog, and recorded in the manifest as soon as it finishes, so
    an interrupted run keeps what it did. Runs under the catalog's ingest lock.
    """
    if not archived_csv_path.exists():
        print(f"Error: no archived manifest to backfill: {archived_csv_path}", file=sys.stderr)
        return 1

    ffmpeg_binary = shutil.which(str(request.ffmpeg_binary))
    ffprobe_binary = shutil.which(str(request.ffprobe_binary))
    if not ffmpeg_binary or not ffprobe_binary:
        missing = request.ffmpeg_binary if not ffmpeg_binary else request.ffprobe_binary
        print(f"Error: not found: {missing}", file=sys.stderr)
        return 1

    with catalog_ingest_lock(archived_csv_path):
        try:
            _, manifest_rows = _read_manifest(archived_csv_path)
        except (OSError, UnicodeDecodeError, csv.Error) as exc:
            print(f"Error: cannot read {archived_csv_path}: {exc}", file=sys.stderr)
            return 1
        use_fdk = select_aac_encoder(ffmpeg_binary)
        jobs, skipped = _select_backfill_jobs(request, rows, manifest_rows)
        return _run_backfill_jobs(
            request, jobs, skipped, archived_csv_path, ffmpeg_binary, ffprobe_binary, use_fdk
        )


def _select_backfill_jobs(
    request: ArchiveRequest,
    rows: list[CsvAudioRow],
    manifest_rows: list[dict[str, str]],
) -> tuple[list[tuple[CsvAudioRow, Path, int]], list[ArchiveSkippedEntry]]:
    rows_by_hash = {row.sha256: row for row in rows}
    jobs: list[tuple[CsvAudioRow, Path, int]] = []
    skipped: list[ArchiveSkippedEntry] = []
    queued: set[str] = set()
    for manifest_row in manifest_rows:
        sha256 = (manifest_row.get("Hash") or "").strip()
        compressed = (manifest_row.get("Compressed Path") or "").strip()
        # Only Opus archives (.webm) get a copy; never replace an .m4a archive.
        if not sha256 or not compressed or Path(compressed).suffix != ".webm":
            continue
        if (manifest_row.get("Format") or "opus") != "opus":
            continue
        # A resumed --overwrite run can list a hash twice; encoding it twice
        # at once would have two ffmpeg processes write the same file.
        if sha256 in queued:
            continue
        existing_copy = (manifest_row.get(AAC_COPY_PATH_COLUMN) or "").strip()
        if existing_copy and Path(existing_copy).is_file() and not request.overwrite:
            continue
        row = rows_by_hash.get(sha256)
        compressed_path = Path(compressed)
        if row is None or not compressed_path.is_file():
            reason = "not in source catalog" if row is None else "archive file not found"
            skipped.append(ArchiveSkippedEntry(sha256, compressed_path, reason))
            continue
        try:
            opus_kbps = int(manifest_row.get("Bitrate (kbps)") or 0)
        except ValueError:
            opus_kbps = 0
        queued.add(sha256)
        jobs.append((row, compressed_path, opus_kbps or OPUS_BITRATES[request.quality]))
    return jobs, skipped


def _run_backfill_jobs(
    request: ArchiveRequest,
    jobs: list[tuple[CsvAudioRow, Path, int]],
    skipped: list[ArchiveSkippedEntry],
    archived_csv_path: Path,
    ffmpeg_binary: str,
    ffprobe_binary: str,
    use_fdk: bool,
) -> int:
    print(f"\nAdding AAC copies to {len(jobs)} archived files in {archived_csv_path.name}")
    for skip in skipped:
        print(f"  skipped {skip.sha256[:8]}: {skip.reason} ({skip.source})")

    added = 0
    if jobs:
        workers = request.parallel or min(max(1, detect_logical_cpus()), len(jobs))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [
                executor.submit(
                    backfill_aac_copy,
                    row,
                    compressed_path,
                    opus_kbps,
                    stereo=request.stereo,
                    ffmpeg_binary=ffmpeg_binary,
                    ffprobe_binary=ffprobe_binary,
                    use_fdk=use_fdk,
                )
                for row, compressed_path, opus_kbps in jobs
            ]
            for done, future in enumerate(as_completed(futures), start=1):
                result = future.result()
                if result.values is not None:
                    # Record each copy as it finishes: an interrupted run
                    # (Ctrl-C, a dropped ssh session) keeps every copy it made.
                    update_manifest_rows(archived_csv_path, {result.sha256: result.values})
                    added += 1
                    print(f"  [{done}/{len(jobs)}] {result.values[AAC_COPY_PATH_COLUMN]}")
                elif result.skipped is not None:
                    skipped.append(result.skipped)
                    print(
                        f"  [{done}/{len(jobs)}] skipped {result.sha256[:8]}: {result.skipped.reason}"
                    )

    print(f"\n  AAC copies added: {added}")
    print(f"  Skipped:          {len(skipped)}")
    print(f"  Manifest:         {archived_csv_path}")
    has_errors = any(
        s.reason not in ("source file not found", "not in source catalog", "archive file not found")
        for s in skipped
    )
    return 1 if has_errors else 0


def handle_archive(
    args: argparse.Namespace | ArchiveRequest,
) -> int:
    """Compress audio files to distribution format with normalization."""
    request = ArchiveRequest.from_args(args)
    # Missing manifest rows should be recomputed even if outputs exist.
    force_existing = True
    # 1. Resolve input catalog
    try:
        csv_path = resolve_catalog_csv(
            request.csv,
            purpose="archive",
            default_symlink=get_default_loudness_symlink(),
        )
    except FileNotFoundError as exc:
        print(exc, file=sys.stderr)
        return 1

    # 2. Load rows
    try:
        rows = load_audio_rows(csv_path, require_duration=True, limit=request.limit)
    except ValueError as exc:
        print(f"Error while reading {csv_path}: {exc}", file=sys.stderr)
        return 1

    if not rows:
        print(f"No rows found in {csv_path}.")
        return 0

    # 3. Derive output CSV path from input CSV (follow stage-audio pattern)
    archived_csv_path = csv_path.with_name(f"{csv_path.stem}_archived.csv")

    # 4. Load existing state if resuming
    try:
        already_archived = load_archived_sha256s(archived_csv_path)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    is_resume = bool(already_archived)

    if request.backfill_aac:
        return run_aac_backfill(request, rows, archived_csv_path)

    if is_resume:
        print(f"Found existing archive manifest: {archived_csv_path}")
        print(f"  Already archived: {len(already_archived)} files")

        # Validate timestamps match between source and archived CSV
        source_ts = extract_timestamp_from_loudness_catalog(csv_path.resolve())
        archived_ts = extract_timestamp_from_archived_catalog(archived_csv_path.resolve())
        if source_ts and archived_ts and source_ts != archived_ts:
            print(
                f"Error: Timestamp mismatch - source catalog ({source_ts}) "
                f"does not match archived CSV ({archived_ts})",
                file=sys.stderr,
            )
            print(
                "  This could indicate mixing archives from different pipeline runs.",
                file=sys.stderr,
            )
            return 1

    # 5. Compute common source root and resolve output directory
    # Always compute source_root from current catalog rows (consistent and reliable)
    source_root = compute_common_source_root(rows)
    print(f"Source root: {source_root}")

    archive_symlink: Path | None = None  # Only set for fresh runs with default path
    if is_resume:
        # Infer output directory from existing archived CSV if not provided
        if request.output_dir is None:
            output_dir, error = infer_output_dir_from_archived_csv(archived_csv_path)
            if error:
                print(f"Error: {error}", file=sys.stderr)
                return 1
            if output_dir is None:
                print(
                    "Error: Could not infer output directory from existing archive CSV",
                    file=sys.stderr,
                )
                return 1

            # Validate output directory timestamp matches source catalog
            source_ts = extract_timestamp_from_loudness_catalog(csv_path.resolve())
            if source_ts and f"audio_archived_{source_ts}" not in str(output_dir):
                print(
                    f"Error: Output directory timestamp does not match source catalog ({source_ts})",
                    file=sys.stderr,
                )
                print(f"  Output dir: {output_dir}", file=sys.stderr)
                return 1

            print(f"  Output dir (from existing): {output_dir}")
        else:
            output_dir = request.output_dir.expanduser().resolve()
    else:
        # Use explicit output_dir or default to audio_artifacts_dir
        if request.output_dir is None:
            # Extract timestamp from source catalog (preserves pipeline coherence)
            timestamp = extract_timestamp_from_loudness_catalog(csv_path.resolve())
            if not timestamp:
                print(
                    f"Error: Loudness catalog '{csv_path.name}' lacks timestamp in filename.\n"
                    "Expected format: audio_catalog_YYYYMMDD_HHMMSS_loudness.csv\n"
                    "Run 'catalog loudness' with a properly timestamped catalog.",
                    file=sys.stderr,
                )
                return 1

            artifacts_root = resolve_audio_artifacts_root()
            output_dir = artifacts_root / f"audio_archived_{timestamp}"
            if not request.no_symlink:
                archive_symlink = artifacts_root / "audio_archived"

            # Validate symlink can be created upfront
            if archive_symlink is not None:
                try:
                    validate_symlink_can_be_created(archive_symlink, description="archived audio")
                except RuntimeError as e:
                    print(f"Error: {e}", file=sys.stderr)
                    return 1
        else:
            output_dir = request.output_dir.expanduser().resolve()

    # Create output directory if needed
    if not output_dir.exists():
        output_dir.mkdir(parents=True, exist_ok=True)
        print(f"Created output directory: {output_dir}")

    # 6. Check ffmpeg/ffprobe availability
    ffmpeg_binary = shutil.which(str(request.ffmpeg_binary))
    if not ffmpeg_binary:
        print(f"Error: ffmpeg not found: {request.ffmpeg_binary}", file=sys.stderr)
        return 1

    ffprobe_binary = shutil.which(str(request.ffprobe_binary))
    if not ffprobe_binary:
        print(f"Error: ffprobe not found: {request.ffprobe_binary}", file=sys.stderr)
        return 1

    # Check encoder availability for M4A and the AAC copy
    write_aac_copy = request.format == "opus" and request.aac_copy
    use_fdk = select_aac_encoder(ffmpeg_binary) if (request.format == "m4a" or write_aac_copy) else False

    # 7. Filter rows to process (skip already archived unless overwrite)
    if request.overwrite:
        rows_to_process = rows
    else:
        rows_to_process = [r for r in rows if r.sha256 not in already_archived]

    if not rows_to_process:
        print("\nAll files already archived. Nothing to do.")
        print("  (Use --overwrite to reprocess existing files)")
        return 0

    skipped_count = len(rows) - len(rows_to_process)

    # 8. Pre-flight symlink validation
    need_symlink = not request.no_symlink and archived_csv_path != get_default_archived_symlink()
    if need_symlink:
        try:
            validate_symlink_can_be_created(
                get_default_archived_symlink(), description="archived catalog"
            )
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1

    # 9. Open manifest writer (append mode if resuming)
    manifest_writer = ArchivedManifestWriter(archived_csv_path, append=is_resume)

    # Create symlinks immediately (point to "current data set")
    if need_symlink:
        create_or_update_symlink(
            get_default_archived_symlink(), archived_csv_path, description="archived catalog"
        )
    if archive_symlink is not None:
        create_or_update_symlink(archive_symlink, output_dir, description="archived audio")

    # 10. Print summary
    extension = FORMAT_EXTENSIONS[request.format]
    print(f"\nArchiving {len(rows_to_process)} audio files")
    if skipped_count > 0:
        print(f"  (Skipping {skipped_count} already archived)")
    print(f"  Format: {request.format} ({extension})")
    print(f"  Quality: {request.quality}")
    print(f"  Channels: {'stereo' if request.stereo else 'mono'}")
    if request.format == "opus":
        print(f"  AAC copy: {'yes' if write_aac_copy else 'no'}")
    print(f"  Output: {output_dir}")
    print()

    # 11. Process files
    compressed: list[CompressedEntry] = []
    skipped: list[ArchiveSkippedEntry] = []
    aac_warnings: list[str] = []
    total = len(rows_to_process)

    # Use parallel processing - default to all available cores
    cpu_limit = max(1, detect_logical_cpus())
    if request.parallel:
        max_workers = request.parallel
    else:
        max_workers = min(cpu_limit, total)

    console = Console()
    console.print(f"[cyan]Using {max_workers} worker(s) for compression[/cyan]")

    try:
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            TextColumn("{task.completed}/{task.total}"),
            TimeElapsedColumn(),
            console=console,
            transient=False,
        ) as progress:
            task = progress.add_task("Compressing audio", total=total)

            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {}
                for row in rows_to_process:
                    source = Path(row.full_path)
                    output_path = compute_output_path(
                        source, source_root, output_dir, extension, row.sha256
                    )

                    future = executor.submit(
                        compress_audio_file,
                        row,
                        output_path,
                        format=request.format,
                        quality=request.quality,
                        stereo=request.stereo,
                        ffmpeg_binary=ffmpeg_binary,
                        ffprobe_binary=ffprobe_binary,
                        use_fdk=use_fdk,
                        force=request.overwrite or force_existing,
                        bitrate_override=request.bitrate,
                        aac_output_path=(
                            output_path.with_suffix(AAC_COPY_EXTENSION) if write_aac_copy else None
                        ),
                    )
                    futures[future] = row

                for future in as_completed(futures):
                    row = futures[future]

                    try:
                        result = future.result()
                    except Exception as exc:
                        result = CompressionResult(
                            compressed=None,
                            skipped=ArchiveSkippedEntry(
                                row.sha256, Path(row.full_path), f"exception: {exc}"
                            ),
                        )

                    if result.compressed:
                        entry = result.compressed
                        compressed.append(entry)
                        manifest_writer.write_entry(entry)
                        if result.warning:
                            aac_warnings.append(entry.sha256)
                            progress.console.print(
                                f"  [yellow]![/yellow] {rich_escape(entry.source.name)}: "
                                f"{rich_escape(result.warning)} (run --backfill-aac to retry)",
                                highlight=False,
                            )
                        ratio_str = f"{entry.compression_ratio:.1f}x"
                        rel_source = rich_escape(entry.source.name)
                        rel_output = rich_escape(entry.compressed.name)
                        progress.console.print(
                            f"  [green]\u2713[/green] {rel_source} \u2192 {rel_output} ({ratio_str})",
                            highlight=False,
                        )
                    elif result.skipped:
                        skip = result.skipped
                        skipped.append(skip)
                        skip_name = rich_escape(skip.source.name)
                        skip_reason = rich_escape(skip.reason)
                        if not request.continue_on_error and skip.reason not in (
                            "output already exists",
                            "source file not found",
                        ):
                            progress.console.print(
                                f"  [red]\u2717[/red] {skip_name}: {skip_reason}",
                                highlight=False,
                            )
                            raise RuntimeError(f"Compression failed: {skip.reason}")
                        else:
                            progress.console.print(
                                f"  [yellow]\u25cb[/yellow] {skip_name}: {skip_reason}",
                                highlight=False,
                            )

                    progress.update(task, advance=1)

    except RuntimeError as exc:
        console.print(f"\n[red]Error:[/red] {exc}")
        manifest_writer.close()
        return 1
    finally:
        manifest_writer.close()

    # 12. Print summary
    print()
    print("=" * 60)
    print("Archive Summary")
    print("=" * 60)
    print(f"  Compressed: {len(compressed)}")
    print(f"  Skipped:    {len(skipped)}")
    if aac_warnings:
        print(f"  Without AAC copy: {len(aac_warnings)} (run --backfill-aac to retry)")
    if is_resume:
        print(f"  Previously archived: {len(already_archived)}")

    if compressed:
        total_source = sum(e.source_size_bytes for e in compressed)
        total_compressed = sum(e.compressed_size_bytes for e in compressed)
        overall_ratio = total_source / total_compressed if total_compressed > 0 else 0
        print(f"  Source size:     {format_size(total_source)}")
        print(f"  Compressed size: {format_size(total_compressed)}")
        print(f"  Overall ratio:   {overall_ratio:.1f}x")

    print(f"\n  Output CSV: {archived_csv_path}")
    if need_symlink:
        print(f"  Symlink:    {get_default_archived_symlink()}")
    print()

    # Return error if any non-trivial failures
    has_errors = any(
        s.reason not in ("output already exists", "source file not found") for s in skipped
    )
    return 1 if has_errors else 0
