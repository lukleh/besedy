"""Tests for lib/data/encoding.py module."""

from __future__ import annotations

import json

import pytest

from besedy.lib.data.encoding import (
    load_json_with_encoding_info,
    load_json_with_fallback,
)


class TestLoadJsonWithFallback:
    """Tests for load_json_with_fallback function."""

    def test_load_utf8_json(self, tmp_path):
        """load_json_with_fallback loads valid UTF-8 JSON."""
        json_file = tmp_path / "test.json"
        data = {"key": "value", "number": 42}
        json_file.write_text(json.dumps(data), encoding="utf-8")

        result = load_json_with_fallback(json_file)
        assert result == data

    def test_load_utf8_with_unicode(self, tmp_path):
        """load_json_with_fallback handles UTF-8 with Unicode characters."""
        json_file = tmp_path / "test.json"
        data = {"text": "Příliš žluťoučký kůň", "emoji": "🎉"}
        json_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

        result = load_json_with_fallback(json_file)
        assert result["text"] == "Příliš žluťoučký kůň"
        assert result["emoji"] == "🎉"

    def test_load_latin1_fallback(self, tmp_path):
        """load_json_with_fallback falls back to latin-1 for legacy files."""
        json_file = tmp_path / "test.json"
        # Create a file that's valid latin-1 but invalid UTF-8
        # This simulates legacy whisper.cpp CoreML dumps
        content = b'{"text": "\xe9"}'  # é in latin-1
        json_file.write_bytes(content)

        result = load_json_with_fallback(json_file)
        assert "text" in result

    def test_load_invalid_json_raises(self, tmp_path):
        """load_json_with_fallback raises ValueError for malformed JSON."""
        json_file = tmp_path / "test.json"
        json_file.write_text("not valid json {", encoding="utf-8")

        with pytest.raises(ValueError) as exc_info:
            load_json_with_fallback(json_file)
        assert "Invalid JSON" in str(exc_info.value)

    def test_load_nested_structure(self, tmp_path):
        """load_json_with_fallback handles nested JSON structures."""
        json_file = tmp_path / "test.json"
        data = {
            "segments": [
                {"start": 0.0, "end": 1.0, "text": "Hello"},
                {"start": 1.0, "end": 2.0, "text": "World"},
            ],
            "metadata": {"duration": 2.0},
        }
        json_file.write_text(json.dumps(data), encoding="utf-8")

        result = load_json_with_fallback(json_file)
        assert len(result["segments"]) == 2
        assert result["metadata"]["duration"] == 2.0


class TestLoadJsonWithEncodingInfo:
    """Tests for load_json_with_encoding_info function."""

    def test_returns_utf8_encoding(self, tmp_path):
        """load_json_with_encoding_info reports utf-8 for valid UTF-8 files."""
        json_file = tmp_path / "test.json"
        data = {"key": "value"}
        json_file.write_text(json.dumps(data), encoding="utf-8")

        result, encoding = load_json_with_encoding_info(json_file)
        assert result == data
        assert encoding == "utf-8"

    def test_returns_latin1_encoding(self, tmp_path):
        """load_json_with_encoding_info reports latin-1 for legacy files."""
        json_file = tmp_path / "test.json"
        # Create a file that triggers latin-1 fallback
        content = b'{"text": "\xe9"}'
        json_file.write_bytes(content)

        result, encoding = load_json_with_encoding_info(json_file)
        assert "text" in result
        assert encoding == "latin-1"

    def test_returns_tuple(self, tmp_path):
        """load_json_with_encoding_info always returns (data, encoding) tuple."""
        json_file = tmp_path / "test.json"
        json_file.write_text('{"a": 1}', encoding="utf-8")

        result = load_json_with_encoding_info(json_file)
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_unicode_in_utf8(self, tmp_path):
        """load_json_with_encoding_info handles Czech text in UTF-8."""
        json_file = tmp_path / "test.json"
        data = {"text": "Dobrý den, jak se máte?"}
        json_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

        result, encoding = load_json_with_encoding_info(json_file)
        assert result["text"] == "Dobrý den, jak se máte?"
        assert encoding == "utf-8"


class TestEncodingEdgeCases:
    """Edge case tests for encoding utilities."""

    def test_empty_json_object(self, tmp_path):
        """Handle empty JSON object."""
        json_file = tmp_path / "test.json"
        json_file.write_text("{}", encoding="utf-8")

        result = load_json_with_fallback(json_file)
        assert result == {}

    def test_empty_json_array(self, tmp_path):
        """Handle empty JSON array (note: type hint says dict but accepts any JSON)."""
        json_file = tmp_path / "test.json"
        json_file.write_text("[]", encoding="utf-8")

        # The type hint says Dict[str, Any] but json.loads accepts any JSON
        # This is a known limitation - transcripts are always objects, not arrays
        result = load_json_with_fallback(json_file)
        assert result == []

    def test_whitespace_preserved(self, tmp_path):
        """JSON with whitespace in values is preserved."""
        json_file = tmp_path / "test.json"
        data = {"text": "  spaces around  "}
        json_file.write_text(json.dumps(data), encoding="utf-8")

        result = load_json_with_fallback(json_file)
        assert result["text"] == "  spaces around  "

    def test_numeric_types(self, tmp_path):
        """JSON numeric types are preserved."""
        json_file = tmp_path / "test.json"
        data = {"int": 42, "float": 3.14, "negative": -1, "zero": 0}
        json_file.write_text(json.dumps(data), encoding="utf-8")

        result = load_json_with_fallback(json_file)
        assert result["int"] == 42
        assert result["float"] == 3.14
        assert result["negative"] == -1
        assert result["zero"] == 0

    def test_boolean_and_null(self, tmp_path):
        """JSON boolean and null types are preserved."""
        json_file = tmp_path / "test.json"
        data = {"true_val": True, "false_val": False, "null_val": None}
        json_file.write_text(json.dumps(data), encoding="utf-8")

        result = load_json_with_fallback(json_file)
        assert result["true_val"] is True
        assert result["false_val"] is False
        assert result["null_val"] is None
