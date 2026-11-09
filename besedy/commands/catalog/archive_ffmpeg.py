"""FFmpeg and loudness helpers for archive.py."""

from __future__ import annotations

import subprocess
from pathlib import Path

from besedy.lib.audio.processing import (
    LoudnessMeasurement,
    loudness_measurement_command,
    loudnorm_filter,
    normalization_filter,
)


def check_encoder_available(ffmpeg_binary: str, encoder: str) -> bool:
    """Check if an encoder is available in ffmpeg."""
    try:
        result = subprocess.run(
            [ffmpeg_binary, "-encoders"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return encoder in result.stdout
    except Exception:
        return False


def probe_input_bitrate(source: Path, ffprobe_binary: str) -> int | None:
    """Probe the audio bitrate of a source file in kbps."""
    cmd = [
        ffprobe_binary,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=bit_rate",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(source),
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            bitrate_str = result.stdout.strip()
            if bitrate_str and bitrate_str != "N/A":
                return int(bitrate_str) // 1000
    except Exception:
        pass
    return None


def probe_input_sample_rate(source: Path, ffprobe_binary: str) -> int | None:
    """Probe the audio sample rate of a source file in Hz."""
    cmd = [
        ffprobe_binary,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=sample_rate",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(source),
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            rate_str = result.stdout.strip()
            if rate_str and rate_str != "N/A":
                return int(rate_str)
    except Exception:
        pass
    return None


def nearest_opus_sample_rate(rate: int) -> int:
    """Find the nearest Opus-supported sample rate for speech."""
    if rate >= 24000:
        return 24000
    if rate >= 16000:
        return 24000 if rate > 20000 else 16000
    if rate >= 12000:
        return 16000 if rate > 14000 else 12000
    if rate >= 8000:
        return 12000 if rate > 10000 else 8000
    return 8000


def analyze_loudness(
    source: Path,
    ffmpeg_binary: str,
) -> tuple[dict[str, str] | None, str | None]:
    """Analyze audio loudness using first-pass loudnorm."""
    # Archive analysis deliberately remains on the source. Recovery decoding
    # and its publication policy are owned by prepare_source in archive.py.
    cmd = loudness_measurement_command(source, ffmpeg_binary, loudnorm_filter(print_json=True))

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
        )
    except Exception as exc:
        return None, f"loudness analysis failed: {exc}"

    stderr = result.stderr.decode("utf-8", errors="replace")
    try:
        return LoudnessMeasurement.from_log(stderr).as_dict(), None
    except ValueError as exc:
        return None, str(exc)


def build_opus_command(
    source: Path,
    output: Path,
    measured: dict[str, str],
    bitrate: int,
    sample_rate: int,
    stereo: bool,
    ffmpeg_binary: str,
    apply_declipping: bool = False,
) -> list[str]:
    """Build ffmpeg command for Opus/WebM compression."""
    audio_filter = normalization_filter(
        LoudnessMeasurement.from_mapping(measured), apply_declipping=apply_declipping
    )

    return [
        ffmpeg_binary,
        "-y",
        "-i",
        str(source),
        "-vn",
        "-af",
        audio_filter,
        "-ar",
        str(sample_rate),
        "-ac",
        "2" if stereo else "1",
        "-c:a",
        "libopus",
        "-b:a",
        f"{bitrate}k",
        "-vbr",
        "on",
        "-compression_level",
        "10",
        "-application",
        "voip",
        str(output),
    ]


def build_m4a_command(
    source: Path,
    output: Path,
    measured: dict[str, str],
    vbr_mode: int,
    sample_rate: int,
    stereo: bool,
    ffmpeg_binary: str,
    use_fdk: bool,
    apply_declipping: bool = False,
) -> list[str]:
    """Build ffmpeg command for M4A/AAC compression."""
    audio_filter = normalization_filter(
        LoudnessMeasurement.from_mapping(measured), apply_declipping=apply_declipping
    )

    cmd = [
        ffmpeg_binary,
        "-y",
        "-i",
        str(source),
        "-vn",
        "-af",
        audio_filter,
        "-ar",
        str(sample_rate),
        "-ac",
        "2" if stereo else "1",
    ]

    if use_fdk:
        cmd.extend(
            [
                "-c:a",
                "libfdk_aac",
                "-profile:a",
                "aac_low",
                "-vbr",
                str(vbr_mode),
                "-afterburner",
                "1",
            ]
        )
    else:
        # VBR 2 is the "low" preset; without an entry it fell through to 68 kbps.
        bitrate_map = {2: 40, 3: 52, 4: 68, 5: 104}
        bitrate = bitrate_map.get(vbr_mode, 68)
        cmd.extend(["-c:a", "aac", "-b:a", f"{bitrate}k"])

    cmd.extend(["-movflags", "+faststart", str(output)])
    return cmd
