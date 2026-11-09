"""Audio-processing primitives; callers own decoding, retries and publication."""

from __future__ import annotations

import json
import math
import shutil
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from besedy.core.paths import validate_mono_wav_16k

ADECLIP_FILTER = "adeclip=window=55:overlap=75:arorder=8:threshold=10:method=a"
ARESAMPLE_FILTER = "aresample=async=1:first_pts=0"
# Speech target/headroom and the allowed linear-normalization range.
LOUDNESS_TARGET_LUFS = -16
LOUDNESS_RANGE_LU = 11
TRUE_PEAK_TARGET_DBTP = -1.5
LOUDNESS_ACCEPTABLE_MIN_LUFS = -20
LOUDNESS_ACCEPTABLE_MAX_LUFS = -12
DECLIP_THRESHOLD_DBTP = -1.0
# A quarter-second floor for short clips, otherwise 2% codec rounding.
DURATION_TOLERANCE_MIN_SECONDS = 0.25
DURATION_TOLERANCE_PERCENTAGE = 0.02


def resolve_audio_executable(binary: str) -> str:
    """Resolve a command or explicit executable path before starting work."""
    resolved = shutil.which(binary)
    if resolved:
        return resolved
    raise RuntimeError(f"Executable '{binary}' is required for audio processing but was not found.")


def parse_loudnorm_output(stderr: str) -> dict[str, Any]:
    """Read the last loudnorm object, tolerating surrounding FFmpeg diagnostics."""
    decoder = json.JSONDecoder()
    lines = stderr.splitlines(keepends=True)
    for index in range(len(lines) - 1, -1, -1):
        if not lines[index].lstrip().startswith("{"):
            continue
        try:
            data, _end = decoder.raw_decode("".join(lines[index:]).lstrip())
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and "input_i" in data:
            return data
    raise ValueError("ffmpeg loudnorm JSON block not found or invalid")


@dataclass(frozen=True)
class LoudnessMeasurement:
    input_i: str
    input_lra: str
    input_tp: str
    input_thresh: str
    target_offset: str

    @classmethod
    def from_log(cls, stderr: str) -> LoudnessMeasurement:
        return cls.from_mapping(parse_loudnorm_output(stderr))

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> LoudnessMeasurement:
        keys = ("input_i", "input_lra", "input_tp", "input_thresh", "target_offset")
        missing = [key for key in keys if data.get(key) in (None, "")]
        if missing:
            raise ValueError(f"ffmpeg loudnorm output missing required metrics: {missing}")
        return cls(*(str(data[key]) for key in keys))

    def as_dict(self) -> dict[str, str]:
        return {
            "input_i": self.input_i,
            "input_lra": self.input_lra,
            "input_tp": self.input_tp,
            "input_thresh": self.input_thresh,
            "target_offset": self.target_offset,
        }


def loudnorm_filter(
    measurement: LoudnessMeasurement | None = None,
    *,
    target_lufs: float = LOUDNESS_TARGET_LUFS,
    loudness_range_lu: float = LOUDNESS_RANGE_LU,
    true_peak_dbtp: float = TRUE_PEAK_TARGET_DBTP,
    linear: bool = True,
    print_json: bool = False,
) -> str:
    expression = f"loudnorm=I={target_lufs}:LRA={loudness_range_lu}:tp={true_peak_dbtp}"
    if measurement:
        expression += (
            f":measured_I={measurement.input_i}:measured_LRA={measurement.input_lra}"
            f":measured_tp={measurement.input_tp}:measured_thresh={measurement.input_thresh}"
            f":offset={measurement.target_offset}:linear={'true' if linear else 'false'}"
        )
    if print_json:
        expression += ":print_format=json"
    return expression


def normalization_filter(
    measurement: LoudnessMeasurement | None,
    *,
    apply_declipping: bool = False,
    async_resample: bool = True,
    linear: bool = True,
) -> str:
    components = [ADECLIP_FILTER] if apply_declipping else []
    if measurement:
        components.append(loudnorm_filter(measurement, linear=linear))
    if async_resample:
        components.append(ARESAMPLE_FILTER)
    return ",".join(components)


def loudness_measurement_command(source: Path, ffmpeg_binary: str, audio_filter: str) -> list[str]:
    return [
        ffmpeg_binary,
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-i",
        str(source),
        "-af",
        audio_filter,
        "-f",
        "null",
        "-",
    ]


def duration_tolerance_seconds(expected: float) -> float:
    """Allow codec rounding while rejecting a materially incomplete candidate."""
    return max(DURATION_TOLERANCE_MIN_SECONDS, expected * DURATION_TOLERANCE_PERCENTAGE)


def validate_audio_duration(actual: float, expected: float) -> None:
    if not all(math.isfinite(value) and value > 0 for value in (actual, expected)):
        raise ValueError("audio candidate has invalid duration")
    if abs(actual - expected) > duration_tolerance_seconds(expected):
        raise ValueError(f"duration mismatch (expected {expected:.2f}s, got {actual:.2f}s)")


def validate_staged_wav(path: Path, expected_duration: float) -> None:
    """Reject empty, truncated or incompatible staging/retry candidates."""
    with wave.open(str(path), "rb") as audio:
        validate_mono_wav_16k(path, audio.getframerate(), audio.getnchannels())
        frames = audio.getnframes()
        if audio.getsampwidth() != 2 or frames <= 0:
            raise ValueError("staged WAV must contain 16-bit PCM audio")
        audio.setpos(frames - 1)
        if len(audio.readframes(1)) != 2:
            raise ValueError("staged WAV contains truncated audio")
        duration = frames / audio.getframerate()
    validate_audio_duration(duration, expected_duration)
