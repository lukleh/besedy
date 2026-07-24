"""FFmpeg and loudness helpers for archive.py."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from besedy.lib.audio.types import LOUDNESS_RANGE_LU, LOUDNESS_TARGET_LUFS, TRUE_PEAK_TARGET_DBTP

ADECLIP_FILTER = "adeclip=window=55:overlap=75:arorder=8:threshold=10:method=a"
ARESAMPLE_FILTER = "aresample=async=1:first_pts=0"


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
    cmd = [
        ffmpeg_binary,
        "-i",
        str(source),
        "-af",
        f"loudnorm=I={LOUDNESS_TARGET_LUFS}:LRA={LOUDNESS_RANGE_LU}:tp={TRUE_PEAK_TARGET_DBTP}:print_format=json",
        "-f",
        "null",
        "-",
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
        )
    except Exception as exc:
        return None, f"loudness analysis failed: {exc}"

    stderr = result.stderr.decode("utf-8", errors="replace")
    if not (json_match := re.search(r"\{[^}]+\}", stderr, re.DOTALL)):
        return None, "could not parse loudnorm JSON output"

    try:
        data = json.loads(json_match.group())
    except json.JSONDecodeError as exc:
        return None, f"invalid loudnorm JSON: {exc}"

    required_keys = [
        "input_i",
        "input_lra",
        "input_tp",
        "input_thresh",
        "target_offset",
    ]
    missing = [key for key in required_keys if key not in data]
    if missing:
        return None, f"loudnorm JSON missing keys: {missing}"

    return data, None


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
    filter_components: list[str] = []
    if apply_declipping:
        filter_components.append(ADECLIP_FILTER)

    filter_components.append(
        f"loudnorm=I={LOUDNESS_TARGET_LUFS}:LRA={LOUDNESS_RANGE_LU}:tp={TRUE_PEAK_TARGET_DBTP}:"
        f"measured_I={measured['input_i']}:"
        f"measured_LRA={measured['input_lra']}:"
        f"measured_tp={measured['input_tp']}:"
        f"measured_thresh={measured['input_thresh']}:"
        f"offset={measured['target_offset']}:linear=true"
    )
    filter_components.append(ARESAMPLE_FILTER)
    audio_filter = ",".join(filter_components)

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
    filter_components: list[str] = []
    if apply_declipping:
        filter_components.append(ADECLIP_FILTER)

    filter_components.append(
        f"loudnorm=I={LOUDNESS_TARGET_LUFS}:LRA={LOUDNESS_RANGE_LU}:tp={TRUE_PEAK_TARGET_DBTP}:"
        f"measured_I={measured['input_i']}:"
        f"measured_LRA={measured['input_lra']}:"
        f"measured_tp={measured['input_tp']}:"
        f"measured_thresh={measured['input_thresh']}:"
        f"offset={measured['target_offset']}:linear=true"
    )
    filter_components.append(ARESAMPLE_FILTER)
    audio_filter = ",".join(filter_components)

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
        bitrate_map = {3: 52, 4: 68, 5: 104}
        bitrate = bitrate_map.get(vbr_mode, 68)
        cmd.extend(["-c:a", "aac", "-b:a", f"{bitrate}k"])

    cmd.extend(["-movflags", "+faststart", str(output)])
    return cmd
