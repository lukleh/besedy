"""Additional edge case tests for whisper.cpp conversion.

These tests cover explicit negative tests for _merge_broken_utf8_tokens failure paths
and complex real-world scenarios.
"""

from __future__ import annotations

import pytest

from besedy.cli.convert_whisper_cpp import (
    WhisperCppConversionError,
    _merge_broken_utf8_tokens,
)


class TestMergeNegativePaths:
    """Explicit negative tests for _merge_broken_utf8_tokens failure paths."""

    def test_segment_text_not_decodable_as_utf8(self):
        """Test when segment text cannot be decoded as UTF-8 after latin-1 read."""
        # Create a byte sequence that is invalid UTF-8
        # For example, 0xFF is not valid in UTF-8
        segment_bytes = bytes([0xFF, 0xFE])
        segment_text_mojibake = segment_bytes.decode("latin-1")

        tokens = [
            {"text": "ÿ", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "þ", "offsets": {"from": 100, "to": 200}, "p": 0.9},
        ]

        # This should raise an error or handle gracefully
        with pytest.raises((UnicodeDecodeError, WhisperCppConversionError)):
            _merge_broken_utf8_tokens(
                tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
            )

    def test_token_byte_sequence_mismatch(self):
        """Test when token bytes don't match ground truth bytes."""
        # Ground truth says "hello" but tokens say something else
        segment_text = "hello"

        tokens = [
            {"text": "goodbye", "offsets": {"from": 0, "to": 100}, "p": 0.9},
        ]

        # This should detect the mismatch
        with pytest.raises(WhisperCppConversionError):
            _merge_broken_utf8_tokens(tokens, segment_text, source_encoding="utf-8", debug=False)

    def test_token_byte_length_mismatch(self):
        """Test when total token bytes don't match ground truth length."""
        # Ground truth is 11 bytes
        segment_bytes = b"hello world"  # 11 bytes
        segment_text_mojibake = segment_bytes.decode("latin-1")

        # But tokens only account for 5 bytes
        tokens = [
            {"text": "hello", "offsets": {"from": 0, "to": 100}, "p": 0.9},
        ]

        # Should detect length mismatch
        with pytest.raises(WhisperCppConversionError):
            _merge_broken_utf8_tokens(
                tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
            )

    def test_empty_segment_with_tokens(self):
        """Test when segment text is empty but tokens exist."""
        segment_text = ""

        tokens = [
            {"text": "hello", "offsets": {"from": 0, "to": 100}, "p": 0.9},
        ]

        # Should raise error about mismatch
        with pytest.raises(WhisperCppConversionError):
            _merge_broken_utf8_tokens(tokens, segment_text, source_encoding="utf-8", debug=False)

    def test_tokens_with_empty_segment_text(self):
        """Test non-empty tokens against empty segment text."""
        segment_text = ""

        tokens = [
            {"text": "a", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "b", "offsets": {"from": 100, "to": 200}, "p": 0.9},
        ]

        # Should raise validation error
        with pytest.raises(WhisperCppConversionError):
            _merge_broken_utf8_tokens(tokens, segment_text, source_encoding="utf-8", debug=False)

    def test_special_tokens_only(self):
        """Test segment with only special tokens and no actual text."""
        segment_text = ""

        tokens = [
            {"text": "[_SOT_]", "offsets": {"from": 0, "to": 0}, "p": 0.99},
            {"text": "[_EOT_]", "offsets": {"from": 0, "to": 0}, "p": 0.99},
        ]

        # Should handle gracefully - special tokens filtered, empty result
        result = _merge_broken_utf8_tokens(
            tokens, segment_text, source_encoding="utf-8", debug=False
        )

        assert len(result) == 0

    def test_incomplete_utf8_sequence_at_end(self):
        """Test when UTF-8 sequence is incomplete at segment end."""
        # Start of 3-byte UTF-8 sequence (€ = E2 82 AC) but only 2 bytes
        segment_bytes = bytes([0xE2, 0x82])  # Incomplete!
        segment_text_mojibake = segment_bytes.decode("latin-1")

        tokens = [
            {"text": "â", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "\x82", "offsets": {"from": 100, "to": 200}, "p": 0.9},
        ]

        # Should raise error about invalid UTF-8
        with pytest.raises((UnicodeDecodeError, WhisperCppConversionError)):
            _merge_broken_utf8_tokens(
                tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
            )

    def test_invalid_utf8_start_byte(self):
        """Test when UTF-8 has invalid start byte (continuation byte used as start)."""
        # 0x80 is a continuation byte, not valid as start byte
        segment_bytes = bytes([0x80, 0x80])
        segment_text_mojibake = segment_bytes.decode("latin-1")

        tokens = [
            {"text": "\x80", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "\x80", "offsets": {"from": 100, "to": 200}, "p": 0.9},
        ]

        # Should raise error about invalid UTF-8
        with pytest.raises((UnicodeDecodeError, WhisperCppConversionError)):
            _merge_broken_utf8_tokens(
                tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
            )


class TestComplexRealWorldScenarios:
    """Test complex scenarios that might occur in real transcriptions."""

    def test_mixed_languages_in_segment(self):
        """Test segment with mixed Latin and Cyrillic text."""
        # Mix of ASCII, 2-byte (ř), and 2-byte Cyrillic (Д = D0 94)
        segment_bytes = "řekl Дмитрий".encode("utf-8")
        segment_text_mojibake = segment_bytes.decode("latin-1")

        tokens = []
        pos = 0
        for char in segment_bytes.decode("latin-1"):
            tokens.append({"text": char, "offsets": {"from": pos, "to": pos + 100}, "p": 0.9})
            pos += 100

        # Should handle mixed scripts correctly
        result = _merge_broken_utf8_tokens(
            tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
        )

        # Verify correct decoding
        merged_text = "".join(t["text"] for t in result)
        assert merged_text == "řekl Дмитрий"

    def test_punctuation_with_multibyte_chars(self):
        """Test punctuation mixed with multibyte characters."""
        text = "Dobrý den, jak se máte?"  # Czech with comma and question mark
        segment_bytes = text.encode("utf-8")
        segment_text_mojibake = segment_bytes.decode("latin-1")

        # Create tokens for each byte
        tokens = []
        for i, byte_char in enumerate(segment_text_mojibake):
            tokens.append(
                {"text": byte_char, "offsets": {"from": i * 100, "to": (i + 1) * 100}, "p": 0.9}
            )

        result = _merge_broken_utf8_tokens(
            tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
        )

        merged_text = "".join(t["text"] for t in result)
        assert merged_text == text

    def test_numbers_and_special_chars_mixed(self):
        """Test numbers, special characters, and UTF-8 mixed together."""
        text = "Cena je 100€, sleva 20%"
        segment_bytes = text.encode("utf-8")
        segment_text_mojibake = segment_bytes.decode("latin-1")

        tokens = []
        for i, byte_char in enumerate(segment_text_mojibake):
            tokens.append(
                {"text": byte_char, "offsets": {"from": i * 50, "to": (i + 1) * 50}, "p": 0.85}
            )

        result = _merge_broken_utf8_tokens(
            tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
        )

        merged_text = "".join(t["text"] for t in result)
        assert merged_text == text
