"""Audio probing utilities using FFprobe.

This module provides functions for:
- Probing audio stream metadata (sample rate, channels)
- Measuring audio duration
- Checking if audio matches target format (16kHz mono WAV)
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from besedy.config.settings import config
from besedy.lib.audio.types import SYMLINK_ELIGIBLE_EXTENSION, TARGET_CHANNELS


def probe_primary_audio_stream(path: Path) -> tuple[int | None, int | None] | None:
    """Probe the primary audio stream for sample rate and channel count.

    Uses ffprobe to extract metadata from the first audio stream.

    Args:
        path: Path to the audio file.

    Returns:
        Tuple of (sample_rate, channels), or None if probing failed.
        Individual values may be None if not available.
    """
    ffprobe_path = shutil.which("ffprobe")
    if not ffprobe_path:
        return None

    probe_cmd = [
        ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=sample_rate,channels",
        "-of",
        "json",
        str(path),
    ]
    try:
        result = subprocess.run(probe_cmd, capture_output=True, text=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None

    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return None

    streams = payload.get("streams")
    if not streams:
        return None

    stream = streams[0] or {}
    sample_rate_raw = stream.get("sample_rate")
    channels_raw = stream.get("channels")

    try:
        sample_rate = int(sample_rate_raw) if sample_rate_raw is not None else None
    except (TypeError, ValueError):
        sample_rate = None

    try:
        channels = int(channels_raw) if channels_raw is not None else None
    except (TypeError, ValueError):
        channels = None

    return sample_rate, channels


def probe_media_duration_seconds(path: Path, *, ffprobe: str) -> tuple[float | None, str | None]:
    """Probe media file for duration using ffprobe.

    Args:
        path: Path to the media file.
        ffprobe: Path to the ffprobe executable.

    Returns:
        Tuple of (duration_seconds, error_message).
        On success: (duration, None)
        On failure: (None, error_description)
    """
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        return None, f"ffprobe failed ({exc})"

    output = (result.stdout or "").strip()
    if not output:
        return None, "ffprobe returned empty duration"
    try:
        return float(output), None
    except (ValueError, TypeError) as exc:
        return None, f"invalid ffprobe duration ({exc})"


def _resolve_ffprobe_binary(ffprobe_binary: str | None = None) -> str:
    """Return a usable ffprobe binary path or raise if unavailable.

    Args:
        ffprobe_binary: Optional explicit path to ffprobe.

    Returns:
        Resolved path to ffprobe executable.

    Raises:
        RuntimeError: If ffprobe is not found.
    """
    candidate = ffprobe_binary or "ffprobe"
    resolved = shutil.which(candidate)
    if resolved:
        return resolved
    raise RuntimeError(
        "ffprobe not found; install ffmpeg and ensure 'ffprobe' is on PATH "
        "or pass ffprobe_binary to measure_audio_duration_seconds()."
    )


def measure_audio_duration_seconds(path: Path, *, ffprobe_binary: str | None = None) -> float:
    """Return the audio duration (seconds) using ffprobe, raising on failure.

    Args:
        path: Path to the audio file.
        ffprobe_binary: Optional explicit path to ffprobe.

    Returns:
        Duration of the audio in seconds.

    Raises:
        FileNotFoundError: If the audio file does not exist.
        RuntimeError: If ffprobe fails or is not available.
    """
    if not path.is_file():
        raise FileNotFoundError(f"Audio file not found for duration probe: {path}")

    ffprobe = _resolve_ffprobe_binary(ffprobe_binary)
    duration, error = probe_media_duration_seconds(path, ffprobe=ffprobe)
    if duration is None:
        raise RuntimeError(f"ffprobe could not read duration for {path}: {error}")
    return float(duration)


def audio_is_wav_mono_16k(path: Path) -> bool:
    """Check if audio file is already in target format (16kHz mono WAV).

    Uses ffprobe to verify sample rate and channel count.

    Args:
        path: Path to the audio file.

    Returns:
        True if file is 16kHz mono WAV, False otherwise.
    """
    if path.suffix.lower() != SYMLINK_ELIGIBLE_EXTENSION:
        return False
    metadata = probe_primary_audio_stream(path)
    if metadata is None:
        return False
    sample_rate, channels = metadata
    return sample_rate == config.audio.sample_rate and channels == TARGET_CHANNELS
