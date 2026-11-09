"""Shared audio primitives, including the FFmpeg contract they produce."""

from __future__ import annotations

import json
import subprocess

import pytest

from besedy.commands.catalog.archive_ffmpeg import analyze_loudness as analyze_archive_loudness
from besedy.lib.audio.processing import (
    LoudnessMeasurement,
    normalization_filter,
    parse_loudnorm_output,
    resolve_audio_executable,
    validate_audio_duration,
    validate_staged_wav,
)
from besedy.lib.audio.quality import analyze_loudness
from tests.helpers.audio import create_tone_wav


def measurement(**changes: str) -> dict[str, str]:
    return {
        "input_i": "-35.0",
        "input_lra": "0.0",
        "input_tp": "-31.0",
        "input_thresh": "-45.0",
        "target_offset": "0.0",
        **changes,
    }


def test_loudnorm_parser_ignores_surrounding_diagnostics_and_uses_last_measurement():
    first = json.dumps(measurement(input_i="-40"))
    last = json.dumps(measurement(input_i="-16"), indent=2)
    log = f"ffmpeg diagnostic {{not json}}\n{first}\n[Parsed_loudnorm] output\n{last}\nsize=N/A\n"
    assert LoudnessMeasurement.from_log(log).input_i == "-16"


@pytest.mark.parametrize("log", ["", "{broken", '{"other": 1}', "[]"])
def test_loudnorm_parser_does_not_treat_unrelated_json_as_measurements(log):
    with pytest.raises(ValueError, match="loudnorm"):
        parse_loudnorm_output(log)


def test_measurement_requires_every_two_pass_field_but_retains_silence_values():
    with pytest.raises(ValueError, match="required metrics"):
        LoudnessMeasurement.from_log('{"input_i": "-16"}')
    values = measurement(input_i="-inf", input_tp="-inf", target_offset="inf")
    assert LoudnessMeasurement.from_log(json.dumps(values)).as_dict() == values


def test_executable_resolution_supports_explicit_paths_and_fails_before_processing(tmp_path):
    executable = tmp_path / "ffmpeg-test"
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o700)
    assert resolve_audio_executable(str(executable)) == str(executable)
    with pytest.raises(RuntimeError, match="required for audio processing"):
        resolve_audio_executable(str(tmp_path / "missing"))


@pytest.mark.parametrize(
    "actual,expected", [(0, 1), (1, 0), (float("nan"), 1), (1, float("inf")), (1, 2)]
)
def test_candidate_duration_rejects_invalid_or_incomplete_audio(actual, expected):
    with pytest.raises(ValueError, match="duration"):
        validate_audio_duration(actual, expected)


def test_duration_floor_accepts_codec_rounding_for_short_audio():
    validate_audio_duration(2.25, 2)
    validate_audio_duration(102, 100)


@pytest.mark.integration
@pytest.mark.parametrize("linear", [True, False])
def test_shared_filter_and_measurement_work_with_real_ffmpeg(tmp_path, require_ffmpeg, linear):
    source = create_tone_wav(tmp_path / "source.wav", duration_seconds=3, amplitude=0.02)
    values, error = analyze_archive_loudness(source, "ffmpeg")
    assert error is None
    assert values is not None
    output = tmp_path / "normalized.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-af",
            normalization_filter(LoudnessMeasurement.from_mapping(values), linear=linear),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(output),
        ],
        check=True,
    )
    validate_staged_wav(output, 3)
    metrics, error = analyze_loudness(output)
    assert error is None
    assert abs(float(metrics["integrated_loudness_lufs"] or "nan") - -16) < 0.3


@pytest.mark.integration
def test_quality_measurement_recovers_damaged_mp3_before_measuring(tmp_path, require_ffmpeg):
    source = create_tone_wav(tmp_path / "source.wav", duration_seconds=3)
    mp3 = tmp_path / "damaged.mp3"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(source), str(mp3)],
        check=True,
    )
    content = mp3.read_bytes()
    middle = len(content) // 2
    mp3.write_bytes(content[:middle] + b"damaged frame" * 10 + content[middle:])
    metrics, error = analyze_loudness(mp3)
    assert error is None
    assert metrics["integrated_loudness_lufs"]
