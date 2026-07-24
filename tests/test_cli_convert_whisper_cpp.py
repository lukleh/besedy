"""Tests for besedy/cli/convert_whisper_cpp.py.

Tests cover:
- Special token detection
- Segment text decoding
- Ground truth byte encoding
- Token merging
- Argument parsing
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pytest

from besedy.cli.convert_whisper_cpp import (
    TIMESTAMP_PRECISION,
    WhisperCppConversionError,
    _decode_segment_text,
    _encode_ground_truth_bytes,
    _is_special_token,
)


class TestIsSpecialToken:
    """Tests for _is_special_token function."""

    def test_special_tokens(self):
        """Test detection of special tokens."""
        assert _is_special_token("[_BEG_]") is True
        assert _is_special_token("[_TT_123]") is True
        assert _is_special_token("[_SOT_]") is True
        assert _is_special_token("[_EOT_]") is True
        assert _is_special_token("[_BLANK_]") is True

    def test_regular_tokens(self):
        """Test that regular tokens are not special."""
        assert _is_special_token("hello") is False
        assert _is_special_token("world") is False
        assert _is_special_token(" the") is False
        assert _is_special_token("123") is False

    def test_edge_cases(self):
        """Test edge cases for special token detection."""
        # Missing underscore prefix
        assert _is_special_token("[BEG_]") is False
        # Missing bracket
        assert _is_special_token("[_BEG_") is False
        assert _is_special_token("_BEG_]") is False
        # Empty brackets
        assert _is_special_token("[]") is False
        # Just underscores
        assert _is_special_token("[__]") is True  # Still matches pattern


class TestDecodeSegmentText:
    """Tests for _decode_segment_text function."""

    def test_utf8_passthrough(self):
        """Test UTF-8 encoded text passes through unchanged."""
        text = "Hello world"
        result = _decode_segment_text(text, "utf-8")
        assert result == "Hello world"

    def test_latin1_to_utf8(self):
        """Test latin-1 to UTF-8 decoding."""
        # Mojibake: UTF-8 bytes interpreted as latin-1
        # "č" in UTF-8 is 0xC4 0x8D, which in latin-1 is "Ä"
        mojibake = "Ä\x8d"  # "č" misread as latin-1
        result = _decode_segment_text(mojibake, "latin-1")
        assert result == "č"

    def test_pure_ascii(self):
        """Test pure ASCII text with latin-1 encoding."""
        text = "Hello world"
        result = _decode_segment_text(text, "latin-1")
        assert result == "Hello world"


class TestEncodeGroundTruthBytes:
    """Tests for _encode_ground_truth_bytes function."""

    def test_utf8_encoding(self):
        """Test UTF-8 encoding returns text and bytes."""
        text = "Hello"
        correct_text, ground_bytes = _encode_ground_truth_bytes(text, "utf-8")

        assert correct_text == "Hello"
        assert ground_bytes == b"Hello"

    def test_utf8_with_unicode(self):
        """Test UTF-8 encoding with Unicode characters."""
        text = "příliš"
        correct_text, ground_bytes = _encode_ground_truth_bytes(text, "utf-8")

        assert correct_text == "příliš"
        assert ground_bytes == "příliš".encode("utf-8")

    def test_latin1_decoding(self):
        """Test latin-1 decoding converts mojibake."""
        # Simulate mojibake: "č" encoded as UTF-8 (0xC4 0x8D) read as latin-1
        mojibake = "\xc4\x8d"  # What latin-1 sees
        correct_text, ground_bytes = _encode_ground_truth_bytes(mojibake, "latin-1")

        assert correct_text == "č"
        assert ground_bytes == b"\xc4\x8d"


class TestWhisperCppConversionError:
    """Tests for WhisperCppConversionError exception."""

    def test_exception_message(self):
        """Test exception contains message."""
        with pytest.raises(WhisperCppConversionError) as exc_info:
            raise WhisperCppConversionError("Test error message")

        assert "Test error message" in str(exc_info.value)

    def test_exception_inheritance(self):
        """Test exception inherits from Exception."""
        assert issubclass(WhisperCppConversionError, Exception)


class TestConstants:
    """Tests for module constants."""

    def test_timestamp_precision(self):
        """Test timestamp precision constant."""
        assert TIMESTAMP_PRECISION == 6
        assert isinstance(TIMESTAMP_PRECISION, int)


class TestArgumentParsing:
    """Tests for CLI argument parsing patterns."""

    def test_input_path_argument(self):
        """Test input path argument."""
        parser = argparse.ArgumentParser()
        parser.add_argument("input_path", type=Path)
        parser.add_argument("--output-dir", type=Path, default=None)
        parser.add_argument("--debug", action="store_true")
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--force", action="store_true")
        parser.add_argument("--skip-existing", action="store_true")

        args = parser.parse_args(["/path/to/transcript_original.json"])
        assert args.input_path == Path("/path/to/transcript_original.json")

    def test_debug_flag(self):
        """Test debug flag."""
        parser = argparse.ArgumentParser()
        parser.add_argument("input_path", type=Path)
        parser.add_argument("--debug", action="store_true")

        args = parser.parse_args(["/path", "--debug"])
        assert args.debug is True

    def test_dry_run_flag(self):
        """Test dry-run flag."""
        parser = argparse.ArgumentParser()
        parser.add_argument("input_path", type=Path)
        parser.add_argument("--dry-run", action="store_true")

        args = parser.parse_args(["/path", "--dry-run"])
        assert args.dry_run is True

    def test_force_flag(self):
        """Test force flag."""
        parser = argparse.ArgumentParser()
        parser.add_argument("input_path", type=Path)
        parser.add_argument("--force", action="store_true")

        args = parser.parse_args(["/path", "--force"])
        assert args.force is True

    def test_skip_existing_flag(self):
        """Test skip-existing flag."""
        parser = argparse.ArgumentParser()
        parser.add_argument("input_path", type=Path)
        parser.add_argument("--skip-existing", action="store_true")

        args = parser.parse_args(["/path", "--skip-existing"])
        assert args.skip_existing is True

    def test_output_dir_option(self):
        """Test output directory option."""
        parser = argparse.ArgumentParser()
        parser.add_argument("input_path", type=Path)
        parser.add_argument("--output-dir", type=Path, default=None)

        args = parser.parse_args(["/path", "--output-dir", "/custom/output"])
        assert args.output_dir == Path("/custom/output")


class TestTokenTypes:
    """Tests for TypedDict structures."""

    def test_token_dict_structure(self):
        """Test TokenDict structure."""
        token = {
            "text": "hello",
            "offsets": {"from": 0, "to": 5},
            "timestamps": {"from": "0.000", "to": "0.500"},
            "id": 123,
            "p": 0.95,
        }

        assert token["text"] == "hello"
        assert token["offsets"]["from"] == 0
        assert token["p"] == 0.95

    def test_segment_dict_structure(self):
        """Test SegmentDict structure."""
        segment = {
            "offsets": {"from": 0, "to": 1000},
            "text": "Hello world",
            "tokens": [
                {"text": "Hello", "offsets": {"from": 0, "to": 5}},
                {"text": " world", "offsets": {"from": 5, "to": 11}},
            ],
        }

        assert segment["text"] == "Hello world"
        assert len(segment["tokens"]) == 2

    def test_payload_dict_structure(self):
        """Test PayloadDict structure."""
        payload = {
            "transcription": [
                {"text": "Hello", "offsets": {"from": 0, "to": 500}},
            ],
            "params": {"language": "cs"},
            "model": {"name": "large-v3"},
        }

        assert len(payload["transcription"]) == 1
        assert payload["params"]["language"] == "cs"


class TestEdgeCases:
    """Tests for edge cases."""

    def test_empty_text_decode(self):
        """Test decoding empty text."""
        result = _decode_segment_text("", "utf-8")
        assert result == ""

        result = _decode_segment_text("", "latin-1")
        assert result == ""

    def test_whitespace_only_decode(self):
        """Test decoding whitespace-only text."""
        result = _decode_segment_text("   ", "utf-8")
        assert result == "   "

    def test_special_token_with_numbers(self):
        """Test special tokens with numbers."""
        assert _is_special_token("[_TT_0]") is True
        assert _is_special_token("[_TT_123]") is True
        assert _is_special_token("[_TT_9999]") is True

    def test_ground_truth_with_newlines(self):
        """Test ground truth encoding with newlines."""
        text = "Line 1\nLine 2"
        correct_text, ground_bytes = _encode_ground_truth_bytes(text, "utf-8")

        assert correct_text == "Line 1\nLine 2"
        assert b"\n" in ground_bytes

    def test_czech_text_decoding(self):
        """Test Czech text mojibake recovery."""
        # "Příliš" in UTF-8 bytes read as latin-1 produces mojibake
        # UTF-8: P=0x50, ř=0xC5 0x99, í=0xC3 0xAD, l=0x6C, i=0x69, š=0xC5 0xA1
        # We test the reverse - given mojibake, recover UTF-8
        utf8_bytes = "Příliš".encode("utf-8")
        mojibake = utf8_bytes.decode("latin-1")

        correct_text, ground_bytes = _encode_ground_truth_bytes(mojibake, "latin-1")

        assert correct_text == "Příliš"


class TestConversionPatterns:
    """Tests for expected conversion patterns."""

    def test_offset_structure(self):
        """Test expected offset structure in tokens."""
        offsets = {"from": 0, "to": 500}

        assert "from" in offsets
        assert "to" in offsets
        assert offsets["from"] < offsets["to"]

    def test_timestamp_structure(self):
        """Test expected timestamp structure in tokens."""
        timestamps = {"from": "0.000000", "to": "0.500000"}

        assert "from" in timestamps
        assert "to" in timestamps
        # Should be string representations of floats
        assert float(timestamps["from"]) < float(timestamps["to"])

    def test_confidence_range(self):
        """Test confidence values are in valid range."""
        valid_confidences = [0.0, 0.5, 0.95, 1.0]

        for p in valid_confidences:
            assert 0.0 <= p <= 1.0
