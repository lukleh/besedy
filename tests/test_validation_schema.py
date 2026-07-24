"""Tests for besedy/lib/validation/core.py schema validation."""

from __future__ import annotations

import json

from besedy.lib.validation.core import validate_shared_schema, validate_single_file


class TestValidateSharedSchema:
    """Tests for validate_shared_schema()."""

    def test_valid_minimal_transcript(self):
        """Minimal valid transcript passes."""
        data = {"segments": [{"start": 0.0, "end": 2.5, "text": "Hello world"}]}
        issues = validate_shared_schema(data)
        assert issues == []

    def test_valid_with_confidence(self):
        """Transcript with confidence passes."""
        data = {"segments": [{"start": 0.0, "end": 2.5, "text": "Hello", "confidence": 0.95}]}
        issues = validate_shared_schema(data)
        assert issues == []

    def test_valid_with_words(self):
        """Transcript with word-level data passes."""
        data = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 2.5,
                    "text": "Hello world",
                    "words": [
                        {"word": "Hello", "start": 0.0, "end": 1.2},
                        {"word": "world", "start": 1.3, "end": 2.5},
                    ],
                }
            ]
        }
        issues = validate_shared_schema(data)
        assert issues == []

    def test_valid_with_word_confidence(self):
        """Word-level confidence is optional and valid."""
        data = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 1.0,
                    "text": "Hi",
                    "words": [{"word": "Hi", "start": 0.0, "end": 1.0, "confidence": 0.98}],
                }
            ]
        }
        issues = validate_shared_schema(data)
        assert issues == []

    def test_valid_with_meta(self):
        """Meta object is optional and valid."""
        data = {
            "meta": {"backend": "faster-whisper", "model": "large-v3"},
            "segments": [{"start": 0.0, "end": 1.0, "text": "test"}],
        }
        issues = validate_shared_schema(data)
        assert issues == []

    # Invalid cases
    def test_missing_segments(self):
        """Missing segments list is invalid."""
        issues = validate_shared_schema({})
        assert len(issues) > 0
        assert any("segments" in issue for issue in issues)

    def test_empty_segments(self):
        """Empty segments list is invalid."""
        issues = validate_shared_schema({"segments": []})
        assert len(issues) > 0

    def test_not_dict_toplevel(self):
        """Top-level must be dict."""
        issues = validate_shared_schema([])
        assert len(issues) > 0
        assert any("object" in issue for issue in issues)

    def test_segment_missing_start(self):
        """Segment missing 'start' is invalid."""
        data = {"segments": [{"end": 1.0, "text": "hello"}]}
        issues = validate_shared_schema(data)
        assert any("start" in issue for issue in issues)

    def test_segment_missing_end(self):
        """Segment missing 'end' is invalid."""
        data = {"segments": [{"start": 0.0, "text": "hello"}]}
        issues = validate_shared_schema(data)
        assert any("end" in issue for issue in issues)

    def test_segment_missing_text(self):
        """Segment missing 'text' is invalid."""
        data = {"segments": [{"start": 0.0, "end": 1.0}]}
        issues = validate_shared_schema(data)
        assert any("text" in issue for issue in issues)

    def test_start_not_number(self):
        """Start must be a number."""
        data = {"segments": [{"start": "zero", "end": 1.0, "text": "hi"}]}
        issues = validate_shared_schema(data)
        assert any("number" in issue for issue in issues)

    def test_end_not_number(self):
        """End must be a number."""
        data = {"segments": [{"start": 0.0, "end": "one", "text": "hi"}]}
        issues = validate_shared_schema(data)
        assert any("number" in issue for issue in issues)

    def test_text_not_string(self):
        """Text must be a string."""
        data = {"segments": [{"start": 0.0, "end": 1.0, "text": 123}]}
        issues = validate_shared_schema(data)
        assert any("string" in issue for issue in issues)

    def test_confidence_not_number(self):
        """Confidence must be a number when present."""
        data = {"segments": [{"start": 0.0, "end": 1.0, "text": "hi", "confidence": "high"}]}
        issues = validate_shared_schema(data)
        assert any("confidence" in issue and "number" in issue for issue in issues)

    def test_words_not_list(self):
        """Words must be a list when present."""
        data = {"segments": [{"start": 0.0, "end": 1.0, "text": "hi", "words": "not a list"}]}
        issues = validate_shared_schema(data)
        assert any("words" in issue and "list" in issue for issue in issues)

    def test_word_missing_word_field(self):
        """Word entry missing 'word' field is invalid."""
        data = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 1.0,
                    "text": "hi",
                    "words": [{"start": 0.0, "end": 1.0}],
                }
            ]
        }
        issues = validate_shared_schema(data)
        assert any("word" in issue and "missing" in issue for issue in issues)

    def test_meta_not_object(self):
        """Meta must be an object when present."""
        data = {
            "meta": "invalid",
            "segments": [{"start": 0.0, "end": 1.0, "text": "test"}],
        }
        issues = validate_shared_schema(data)
        assert any("meta" in issue for issue in issues)

    def test_multiple_segments(self):
        """Multiple valid segments pass."""
        data = {
            "segments": [
                {"start": 0.0, "end": 2.0, "text": "First segment"},
                {"start": 2.0, "end": 4.0, "text": "Second segment"},
                {"start": 4.0, "end": 6.0, "text": "Third segment"},
            ]
        }
        issues = validate_shared_schema(data)
        assert issues == []

    def test_integer_timestamps_valid(self):
        """Integer timestamps are valid numbers."""
        data = {"segments": [{"start": 0, "end": 1, "text": "test"}]}
        issues = validate_shared_schema(data)
        assert issues == []


class TestValidateSingleFile:
    """Tests for validate_single_file()."""

    def test_valid_file_passes(self, tmp_path):
        """Valid transcript file passes validation."""
        transcript = tmp_path / "transcript.json"
        data = {"segments": [{"start": 0.0, "end": 1.0, "text": "test"}]}
        transcript.write_text(json.dumps(data))

        result = validate_single_file(transcript, quiet=True)
        assert result is True

    def test_nonexistent_file_fails(self, tmp_path):
        """Nonexistent file fails validation."""
        nonexistent = tmp_path / "missing.json"
        result = validate_single_file(nonexistent, quiet=True)
        assert result is False

    def test_invalid_json_fails(self, tmp_path):
        """Invalid JSON fails validation."""
        bad_json = tmp_path / "bad.json"
        bad_json.write_text("not valid json {")
        result = validate_single_file(bad_json, quiet=True)
        assert result is False

    def test_invalid_schema_fails(self, tmp_path):
        """Invalid schema fails validation."""
        transcript = tmp_path / "transcript.json"
        # Missing required fields
        data = {"segments": [{"text": "no timestamps"}]}
        transcript.write_text(json.dumps(data))

        result = validate_single_file(transcript, quiet=True)
        assert result is False

    def test_summary_dict_populated(self, tmp_path):
        """Summary dict is populated with stats."""
        transcript = tmp_path / "transcript.json"
        data = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 2.0,
                    "text": "Hello world",
                    "words": [
                        {"word": "Hello", "start": 0.0, "end": 1.0},
                        {"word": "world", "start": 1.0, "end": 2.0},
                    ],
                }
            ]
        }
        transcript.write_text(json.dumps(data))

        summary = {}
        result = validate_single_file(transcript, quiet=True, summary=summary)

        assert result is True
        assert summary["status"] == "passed"
        assert summary["segments"] == 1
        assert summary["words"] == 2
