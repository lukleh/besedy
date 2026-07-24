"""Shared helpers for decoding audio files to temporary WAV format.

This module provides a safe decoding function that handles corrupted audio files
gracefully by using ffmpeg's error detection and recovery options.

The key insight is that ffmpeg's loudnorm filter can lose audio at the end of
corrupted files (MP3s with frame errors, etc.) when processing the source directly.
By first decoding to a clean WAV file, the loudnorm filter operates on clean PCM
data and preserves the full duration.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from besedy.lib.subprocess_utils import safe_decode


def decode_to_temp_wav(
    source: Path,
    temp_path: Path,
    *,
    ffmpeg_binary: str | None = None,
    timeout: int | None = None,
) -> tuple[bool, str | None]:
    """Decode source audio to a temporary WAV file, handling corruption gracefully.

    This function creates a clean PCM WAV file from the source audio, using ffmpeg's
    error detection options to handle corrupted frames without losing audio data.

    The resulting WAV file can then be used as input for loudnorm analysis or
    normalization, avoiding the buffer sync issues that occur when loudnorm
    processes corrupted source files directly.

    Args:
        source: Path to the source audio file (MP3, FLAC, etc.)
        temp_path: Path where the temporary WAV file should be written
        ffmpeg_binary: Optional path to ffmpeg executable. If None, uses PATH.
        timeout: Optional timeout in seconds for the ffmpeg process.

    Returns:
        Tuple of (success, error_message).
        On success: (True, None)
        On failure: (False, error_description)

    Example:
        >>> temp_wav = Path("/tmp/decode_abc123.wav")
        >>> ok, err = decode_to_temp_wav(source_mp3, temp_wav)
        >>> if ok:
        ...     # Process temp_wav with loudnorm
        ...     pass
        >>> temp_wav.unlink(missing_ok=True)
    """
    if ffmpeg_binary is None:
        ffmpeg_binary = shutil.which("ffmpeg")
        if ffmpeg_binary is None:
            return False, "ffmpeg executable not found in PATH"

    # Ensure parent directory exists
    temp_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        ffmpeg_binary,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",  # Overwrite output
        "-err_detect",
        "ignore_err",  # Handle corrupted frames gracefully
        "-fflags",
        "+genpts",  # Generate presentation timestamps
        "-i",
        str(source),
        "-vn",  # No video
        "-c:a",
        "pcm_s16le",  # 16-bit PCM
        str(temp_path),
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            check=False,  # We'll check returncode manually
        )
    except subprocess.TimeoutExpired:
        # Clean up partial output
        temp_path.unlink(missing_ok=True)
        return False, f"ffmpeg decode timed out after {timeout} seconds"
    except Exception as exc:
        temp_path.unlink(missing_ok=True)
        return False, f"ffmpeg decode failed: {exc}"

    if result.returncode != 0:
        # Clean up partial output
        temp_path.unlink(missing_ok=True)
        stderr_text = safe_decode(result.stderr).strip()
        detail = stderr_text.splitlines()[-1] if stderr_text else f"exit code {result.returncode}"
        return False, f"ffmpeg decode failed: {detail}"

    # Verify output file exists and has content
    if not temp_path.exists():
        return False, "ffmpeg decode produced no output file"

    try:
        size = temp_path.stat().st_size
        if size <= 44:  # WAV header is 44 bytes minimum
            temp_path.unlink(missing_ok=True)
            return False, "ffmpeg decode produced empty WAV file"
    except OSError as exc:
        temp_path.unlink(missing_ok=True)
        return False, f"failed to verify decoded file: {exc}"

    return True, None
