"""Converters and explicit validation policies share one transcript contract."""

from __future__ import annotations

import math

import pytest

from besedy.cli.convert_stable_ts import StableTsConversionError, convert_stable_ts
from besedy.lib.data.whisperx_conversion import WhisperXConversionError, convert_whisperx
from besedy.lib.validation.schema import validate_canonical_schema, validate_transcript_schema

CONVERTERS = [
    (convert_whisperx, WhisperXConversionError, "score"),
    (convert_stable_ts, StableTsConversionError, "probability"),
]


def convert(converter, segments):
    return converter(
        {"language": "cs", "segments": segments},
        backend="whisperx",
        model="model",
        duration_seconds=10,
        audio_filepath="audio.wav",
    )


@pytest.mark.parametrize("converter,error_type,score_field", CONVERTERS)
def test_converters_produce_the_same_valid_timing_and_unknown_confidence(
    converter, error_type, score_field
):
    result = convert(
        converter,
        [
            {
                "start": 0,
                "end": 1,
                "text": "first",
                "words": [{"start": 2, "end": 3, "word": "first"}],
            },
            {"start": 0.5, "end": 0.8, "text": "second", "words": [{"word": "second"}]},
        ],
    )
    assert result["segments"][0]["words"][0] == {
        "start": 1,
        "end": 1,
        "word": "first",
        "confidence": None,
    }
    assert result["segments"][1]["start"] == result["segments"][1]["end"] == 1
    assert result["meta"]["transcript_text"] == "first second"
    assert result["meta"]["num_words"] == 2
    assert validate_transcript_schema(result) == validate_canonical_schema(result) == []


@pytest.mark.parametrize("converter,error_type,score_field", CONVERTERS)
def test_format_adapters_choose_only_their_confidence_field(converter, error_type, score_field):
    result = convert(
        converter,
        [
            {
                "start": 0,
                "end": 1,
                "text": "a",
                "words": [
                    {"word": "a", score_field: 1.4},
                    {"word": "b", score_field: -0.2},
                ],
            }
        ],
    )
    assert [w["confidence"] for w in result["segments"][0]["words"]] == [1, 0]
    assert result["segments"][0]["confidence"] == 0.5


@pytest.mark.parametrize("converter,error_type,score_field", CONVERTERS)
@pytest.mark.parametrize("value", [True, "invalid", math.nan, math.inf, -math.inf])
def test_unusable_word_timing_has_a_format_specific_error(
    converter, error_type, score_field, value
):
    with pytest.raises(error_type, match=r"segment\[0\].words\[0\].start must be a finite number"):
        convert(
            converter,
            [{"start": 0, "end": 1, "text": "a", "words": [{"word": "a", "start": value}]}],
        )


@pytest.mark.parametrize("converter,error_type,score_field", CONVERTERS)
@pytest.mark.parametrize(
    "payload",
    [None, [], {"segments": None}, {"segments": [None]}, {"segments": [{"words": "invalid"}]}],
)
def test_bad_converter_shapes_raise_conversion_errors(converter, error_type, score_field, payload):
    with pytest.raises(error_type):
        converter(
            payload, backend="whisperx", model="model", duration_seconds=1, audio_filepath=None
        )


@pytest.mark.parametrize("validator", [validate_transcript_schema, validate_canonical_schema])
@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {"meta": None, "segments": []},
        {"meta": {"backend": []}, "segments": [None]},
        {"segments": [{"start": "x", "end": 1, "text": "a", "words": [{"start": 0, "end": 1}]}]},
        {"segments": [{"start": 0, "end": 1, "text": "a", "words": [None]}]},
    ],
)
def test_bad_validation_shapes_are_issues_not_exceptions(validator, payload):
    assert validator(payload)


@pytest.mark.parametrize("validator", [validate_transcript_schema, validate_canonical_schema])
@pytest.mark.parametrize(
    "field,value",
    [
        ("start", True),
        ("start", math.nan),
        ("end", math.inf),
        ("confidence", math.nan),
        ("confidence", 2),
    ],
)
def test_both_validators_reject_nonfinite_numbers_and_invalid_confidence(validator, field, value):
    payload = convert(convert_whisperx, [{"start": 0, "end": 1, "text": "a"}])
    payload["segments"][0][field] = value
    assert validator(payload)


def test_field_policies_remain_explicit_without_conflicting_value_rules():
    minimal = {"segments": [{"start": 0, "end": 1, "text": "a"}]}
    assert validate_transcript_schema(minimal) == []
    assert validate_canonical_schema(minimal)
    silent = convert(convert_whisperx, [])
    assert validate_canonical_schema(silent) == []
    assert validate_transcript_schema(silent)
    minimal["segments"][0]["words"] = [{"word": "a", "start": 2, "end": 3}]
    assert any("bounds" in issue for issue in validate_transcript_schema(minimal))


def test_backend_metadata_options_stay_with_the_format_adapter():
    payload = {"language": "cs", "segments": []}
    whisperx = convert_whisperx(
        payload,
        backend="whisperx",
        model="model",
        duration_seconds=1,
        audio_filepath=None,
        align_model="aligner",
        vad_method="silero",
        compute_type="int8",
        batch_size=2,
    )
    stable = convert_stable_ts(
        payload,
        backend="whisperx",
        model="model",
        duration_seconds=1,
        audio_filepath=None,
        stable_backend="faster-whisper",
    )
    assert whisperx["meta"]["generation_params"] == {
        "language": "cs",
        "align_model": "aligner",
        "vad_method": "silero",
        "compute_type": "int8",
        "batch_size": 2,
    }
    assert stable["meta"]["generation_params"] == {
        "language": "cs",
        "stable_ts_backend": "faster-whisper",
    }
