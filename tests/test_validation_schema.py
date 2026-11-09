"""All transcript validation entry points enforce the current canonical schema."""

from __future__ import annotations

import copy
import json

import pytest

from besedy.lib.validation.core import validate_single_file
from besedy.lib.validation.quickcheck import quick_validate
from besedy.lib.validation.schema import validate_canonical_schema
from tests.helpers.transcript import create_transcript_with_words


def test_current_transcript_passes_all_entry_points(tmp_path):
    data = create_transcript_with_words(["Hello", "world"])
    data["segments"][0]["confidence"] = None
    data["segments"][0]["words"][0]["confidence"] = None
    path = tmp_path / "transcript.json"
    path.write_text(json.dumps(data))
    assert validate_canonical_schema(data) == []
    assert validate_single_file(path, quiet=True)
    assert quick_validate(path)[0]


@pytest.mark.parametrize("field", ["meta", "segments"])
def test_required_top_level_fields(field):
    data = create_transcript_with_words(["Hello"])
    del data[field]
    assert any(field in issue for issue in validate_canonical_schema(data))


@pytest.mark.parametrize(
    "field", ["model", "backend", "audio_filepath", "duration", "generation_params"]
)
def test_required_metadata_fields(field):
    data = create_transcript_with_words(["Hello"])
    del data["meta"][field]
    assert any(field in issue for issue in validate_canonical_schema(data))


@pytest.mark.parametrize(
    "field,value",
    [
        ("model", None),
        ("audio_filepath", 1),
        ("backend", []),
        ("duration", True),
        ("duration", "1"),
        ("duration", -1),
        ("duration", float("nan")),
        ("duration", float("inf")),
        ("generation_params", []),
    ],
)
def test_invalid_metadata_is_rejected_by_all_entry_points(tmp_path, field, value):
    data = create_transcript_with_words(["Hello"])
    data["meta"][field] = value
    path = tmp_path / "transcript.json"
    path.write_text(json.dumps(data))

    assert any(f"meta.{field}" in issue for issue in validate_canonical_schema(data))
    assert not validate_single_file(path, quiet=True)
    assert not quick_validate(path)[0]


@pytest.mark.parametrize("field", ["start", "end", "text", "confidence", "words"])
def test_required_segment_fields(field):
    data = create_transcript_with_words(["Hello"])
    del data["segments"][0][field]
    assert any(field in issue for issue in validate_canonical_schema(data))


@pytest.mark.parametrize("field", ["start", "end", "word", "confidence"])
def test_required_word_fields(field):
    data = create_transcript_with_words(["Hello"])
    del data["segments"][0]["words"][0][field]
    assert any(field in issue for issue in validate_canonical_schema(data))


@pytest.mark.parametrize("value", [[], None, "transcript", 1])
def test_invalid_top_level_is_reported(value):
    assert validate_canonical_schema(value)


@pytest.mark.parametrize(
    "field,value",
    [
        ("start", "zero"),
        ("end", True),
        ("confidence", "high"),
        ("confidence", float("nan")),
        ("confidence", 1.1),
        ("text", 1),
        ("words", {}),
    ],
)
def test_invalid_segment_values_are_reported(field, value):
    data = create_transcript_with_words(["Hello"])
    data["segments"][0][field] = value
    assert validate_canonical_schema(data)


@pytest.mark.parametrize("value", [None, "word", 1])
def test_nonobject_words_are_reported(value):
    data = create_transcript_with_words(["Hello"])
    data["segments"][0]["words"] = [value]
    assert validate_canonical_schema(data)


def test_silent_current_transcript_is_valid():
    data = create_transcript_with_words(["Hello"])
    data["segments"] = []
    assert validate_canonical_schema(data) == []


def test_segment_and_word_timing_remain_validated():
    data = create_transcript_with_words(["Hello"])
    data["segments"].append(copy.deepcopy(data["segments"][0]))
    assert any("not monotonic" in issue for issue in validate_canonical_schema(data))
    data["segments"] = data["segments"][:1]
    data["segments"][0]["words"][0]["end"] = 2
    assert any("segment bounds" in issue for issue in validate_canonical_schema(data))


def test_cli_reports_missing_invalid_and_incomplete_files(tmp_path):
    path = tmp_path / "transcript.json"
    assert not validate_single_file(path, quiet=True)
    for raw in ["not json", json.dumps({"segments": [{"start": 0, "end": 1, "text": "old"}]})]:
        path.write_text(raw)
        summary = {}
        assert not validate_single_file(path, quiet=True, summary=summary)
        assert summary["status"] == "failed"


@pytest.mark.parametrize(
    "data", [None, [], {"meta": []}, {"segments": [None]}, {"segments": "invalid"}]
)
def test_both_file_validators_report_malformed_shapes(tmp_path, data):
    path = tmp_path / "transcript.json"
    path.write_text(json.dumps(data))
    assert not validate_single_file(path, quiet=True)
    assert not quick_validate(path)[0]
