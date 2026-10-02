"""Tests for lib/data/encoding.py module."""

from __future__ import annotations

import json

import pytest

from besedy.lib.data.encoding import load_json_with_fallback


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

    def test_load_non_utf8_raises(self, tmp_path):
        """load_json_with_fallback rejects non-UTF-8 bytes instead of dropping them."""
        json_file = tmp_path / "test.json"
        json_file.write_bytes('{"text": "café"}'.encode("latin-1"))

        with pytest.raises(ValueError) as exc_info:
            load_json_with_fallback(json_file)
        message = str(exc_info.value)
        assert str(json_file) in message
        assert "not valid UTF-8" in message
        assert "byte offset 13" in message

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
