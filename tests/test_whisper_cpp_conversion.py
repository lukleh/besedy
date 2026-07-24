"""Test cases for whisper.cpp conversion and token merging logic."""

from __future__ import annotations

import pytest

from besedy.cli.convert_whisper_cpp import (
    WhisperCppConversionError,
    _build_words_from_tokens,
    _is_special_token,
    _merge_broken_utf8_tokens,
    convert_whisper_cpp,
)


def _latin1_mojibake(text: str) -> str:
    """Encode text as UTF-8 bytes and mis-decode via latin-1 to mimic whisper dumps."""
    return text.encode("utf-8").decode("latin-1")


class TestSpecialTokens:
    """Test special token detection and handling."""

    def test_special_token_detection(self):
        """Test special token detection."""
        assert _is_special_token("[_BEG_]") is True
        assert _is_special_token("[_TT_500]") is True
        assert _is_special_token("[_TT_1000]") is True
        assert _is_special_token("[_EOT_]") is True
        assert _is_special_token("[_SOT_]") is True
        assert _is_special_token("[_LANG_en]") is True
        assert _is_special_token("hello") is False
        assert _is_special_token("[not_closed") is False
        assert _is_special_token("not_opened]") is False

    def test_special_tokens_in_stream(self):
        """Test special tokens interspersed with text."""
        # Text "hi" with special tokens before, between, and after
        segment_text = "hi"

        tokens = [
            {"text": "[_BEG_]", "offsets": {"from": 0, "to": 0}, "p": 0.9},
            {"text": "h", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "[_TT_500]", "offsets": {"from": 500, "to": 500}, "p": 0.9},
            {"text": "i", "offsets": {"from": 100, "to": 200}, "p": 0.85},
            {"text": "[_TT_1000]", "offsets": {"from": 1000, "to": 1000}, "p": 0.9},
        ]

        result = _merge_broken_utf8_tokens(
            tokens, segment_text, source_encoding="utf-8", debug=False
        )

        assert len(result) == 2  # Only 'h' and 'i', special tokens filtered
        assert "".join(t["text"] for t in result) == "hi"

    def test_special_token_interrupting_utf8_split(self):
        """Test special token appearing in the middle of a split UTF-8 sequence.

        Note: This is a pathological case that shouldn't happen in practice,
        but we should handle it gracefully by detecting the byte mismatch.
        """
        # If this case occurs, it means the special token is incorrectly placed
        # and the byte stream won't match. This should raise an error.
        segment_text_mojibake = "mÃ½"  # "mý"

        tokens = [
            {"text": "m", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "Ã", "offsets": {"from": 100, "to": 150}, "p": 0.8},
            {"text": "[_TT_500]", "offsets": {"from": 500, "to": 500}, "p": 0.9},
            # Missing second byte - this will cause mismatch
        ]

        with pytest.raises(WhisperCppConversionError) as exc_info:
            _merge_broken_utf8_tokens(
                tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
            )

        assert "doesn't match ground truth" in str(exc_info.value)


class TestUTF8Merging:
    """Test UTF-8 byte sequence merging."""

    def test_simple_ascii(self):
        """Test simple ASCII text (no UTF-8 splitting)."""
        segment_text = "hello world"
        tokens = [
            {"text": "hello", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": " ", "offsets": {"from": 100, "to": 110}, "p": 0.95},
            {"text": "world", "offsets": {"from": 110, "to": 200}, "p": 0.85},
        ]

        result = _merge_broken_utf8_tokens(
            tokens, segment_text, source_encoding="utf-8", debug=False
        )

        assert len(result) == 11  # 11 characters
        assert "".join(t["text"] for t in result) == segment_text
        assert result[0]["text"] == "h"
        assert result[5]["text"] == " "
        assert result[6]["text"] == "w"

    def test_multibyte_utf8_split(self):
        """Test multi-byte UTF-8 character split across tokens (Czech ý = C3 BD)."""
        # Czech text "mý" where ý is split across two tokens
        # Correct bytes: [0x6D, 0xC3, 0xBD] = "mý"
        # When read as latin-1: "mÃ½"
        segment_text_mojibake = "mÃ½"

        tokens = [
            {"text": "m", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "Ã", "offsets": {"from": 100, "to": 150}, "p": 0.8},  # First byte of ý
            {"text": "½", "offsets": {"from": 150, "to": 200}, "p": 0.8},  # Second byte of ý
        ]

        result = _merge_broken_utf8_tokens(
            tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
        )

        assert len(result) == 2  # 2 characters: 'm' and 'ý'
        correct_text = "".join(t["text"] for t in result)
        assert correct_text == "mý"

        # First character 'm' from one token
        assert result[0]["text"] == "m"
        assert result[0]["offsets"]["from"] == 0
        assert result[0]["offsets"]["to"] == 100

        # Second character 'ý' from two merged tokens
        assert result[1]["text"] == "ý"
        assert result[1]["offsets"]["from"] == 100  # Start of first token
        assert result[1]["offsets"]["to"] == 200  # End of last token
        assert result[1]["p"] == 0.8  # Average of 0.8 and 0.8

    def test_three_byte_utf8_split(self):
        """Test 3-byte UTF-8 character split across tokens (€ = E2 82 AC)."""
        # Text "€5" where € is split across three tokens
        # Correct bytes: [0xE2, 0x82, 0xAC, 0x35] = "€5"
        # When those bytes are interpreted as latin-1 characters, we get:
        # 0xE2 = â, 0x82 = \x82, 0xAC = ¬
        segment_bytes = bytes([0xE2, 0x82, 0xAC, 0x35])  # Actual UTF-8 bytes for "€5"
        segment_text_mojibake = segment_bytes.decode("latin-1")  # Read as latin-1 → "â\x82¬5"

        # Tokens contain the mojibake characters
        tokens = [
            {"text": "â", "offsets": {"from": 0, "to": 100}, "p": 0.7},  # Byte 1 of €
            {"text": "\x82", "offsets": {"from": 100, "to": 150}, "p": 0.75},  # Byte 2 of €
            {"text": "¬", "offsets": {"from": 150, "to": 200}, "p": 0.8},  # Byte 3 of €
            {"text": "5", "offsets": {"from": 200, "to": 250}, "p": 0.95},
        ]

        result = _merge_broken_utf8_tokens(
            tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
        )

        assert len(result) == 2  # 2 characters: '€' and '5'
        correct_text = "".join(t["text"] for t in result)
        assert correct_text == "€5"

        # First character '€' from three merged tokens
        assert result[0]["text"] == "€"
        assert result[0]["offsets"]["from"] == 0
        assert result[0]["offsets"]["to"] == 200
        avg_conf = (0.7 + 0.75 + 0.8) / 3
        assert abs(result[0]["p"] - avg_conf) < 0.01

        # Second character '5' from one token
        assert result[1]["text"] == "5"
        assert result[1]["offsets"]["from"] == 200
        assert result[1]["offsets"]["to"] == 250

    def test_token_spanning_multiple_chars(self):
        """Test a single token that contains multiple UTF-8 characters."""
        # Text "abc" where "ab" is one token and "c" is another
        segment_text = "abc"

        tokens = [
            {"text": "ab", "offsets": {"from": 0, "to": 150}, "p": 0.9},
            {"text": "c", "offsets": {"from": 150, "to": 200}, "p": 0.85},
        ]

        result = _merge_broken_utf8_tokens(
            tokens, segment_text, source_encoding="utf-8", debug=False
        )

        assert len(result) == 3  # 3 characters
        assert "".join(t["text"] for t in result) == "abc"

        # Characters 'a' and 'b' should both reference the first token
        assert result[0]["text"] == "a"
        assert result[0]["offsets"]["from"] == 0
        assert result[0]["offsets"]["to"] == 150  # Uses entire first token

        assert result[1]["text"] == "b"
        assert result[1]["offsets"]["from"] == 0
        assert result[1]["offsets"]["to"] == 150  # Also uses entire first token

        assert result[2]["text"] == "c"
        assert result[2]["offsets"]["from"] == 150
        assert result[2]["offsets"]["to"] == 200

    def test_complex_czech_text(self):
        """Test real Czech text with multiple multi-byte characters."""
        # Czech: "máš" (you have)
        segment_text_mojibake = "máš"  # Already correct UTF-8 for this test

        tokens = [
            {"text": "m", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "á", "offsets": {"from": 100, "to": 200}, "p": 0.85},
            {"text": "š", "offsets": {"from": 200, "to": 300}, "p": 0.8},
        ]

        result = _merge_broken_utf8_tokens(
            tokens, segment_text_mojibake, source_encoding="utf-8", debug=False
        )

        assert len(result) == 3
        assert "".join(t["text"] for t in result) == "máš"

    def test_token_bytes_length_mismatch(self):
        """Ensure we detect when token bytes don't cover the text."""
        segment_text = "ab"
        tokens = [
            {"text": "a", "offsets": {"from": 0, "to": 50}, "p": 0.9},
            # Missing token for 'b'
        ]

        with pytest.raises(WhisperCppConversionError) as exc_info:
            _merge_broken_utf8_tokens(tokens, segment_text, source_encoding="utf-8", debug=False)

        assert "Token bytes length" in str(exc_info.value)

    def test_extra_token_bytes_raise(self):
        """Extra bytes compared to the ground truth should fail validation."""
        segment_text = "ab"
        tokens = [
            {"text": "ab", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "c", "offsets": {"from": 100, "to": 150}, "p": 0.8},
        ]

        with pytest.raises(WhisperCppConversionError) as exc_info:
            _merge_broken_utf8_tokens(tokens, segment_text, source_encoding="utf-8", debug=False)

        assert "Token bytes length" in str(exc_info.value)

    def test_empty_tokens(self):
        """Test handling of empty token texts."""
        segment_text = "hi"

        tokens = [
            {"text": "h", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "", "offsets": {"from": 100, "to": 100}, "p": 0.95},  # Empty token
            {"text": "i", "offsets": {"from": 100, "to": 200}, "p": 0.85},
        ]

        result = _merge_broken_utf8_tokens(
            tokens, segment_text, source_encoding="utf-8", debug=False
        )

        assert len(result) == 2
        assert "".join(t["text"] for t in result) == "hi"


class TestWordBuilding:
    """Test word construction from merged tokens."""

    def test_newline_word_boundary(self):
        """Ensure newline tokens split words correctly."""
        merged_tokens = [
            {"text": "foo", "offsets": {"from": 0, "to": 300}, "p": 0.9},
            {"text": "\n", "offsets": {"from": 300, "to": 320}, "p": 0.8},
            {"text": " bar", "offsets": {"from": 320, "to": 600}, "p": 0.85},
        ]

        words = _build_words_from_tokens(merged_tokens, "foo\nbar", 0.0, 0.6)
        assert [w["word"] for w in words] == ["foo", "bar"]

    def test_timestamp_normalization(self):
        """Word timestamps should stretch to cover the full segment."""
        merged_tokens = [
            {"text": "foo", "offsets": {"from": 100, "to": 300}, "p": 0.9},
            {"text": " bar", "offsets": {"from": 600, "to": 900}, "p": 0.95},
        ]

        words = _build_words_from_tokens(merged_tokens, "foo bar", 5.0, 9.0)

        # Timestamps should be normalized to fit within segment [5.0, 9.0]
        assert abs(words[0]["start"] - 5.0) < 1e-6
        assert abs(words[0]["end"] - 6.0) < 1e-6
        assert abs(words[1]["start"] - 7.5) < 1e-6
        assert abs(words[1]["end"] - 9.0) < 1e-6

    def test_varied_whitespace_boundaries(self):
        """Tabs/NBSP should also trigger new word boundaries."""
        merged_tokens = [
            {"text": "foo", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "\tbar", "offsets": {"from": 100, "to": 200}, "p": 0.8},
            {"text": "\u00a0baz", "offsets": {"from": 200, "to": 300}, "p": 0.7},
        ]

        words = _build_words_from_tokens(merged_tokens, "foo\tbar\u00a0baz", 0.0, 0.3)
        assert [w["word"] for w in words] == ["foo", "bar", "baz"]

    def test_missing_offsets_fall_back_to_segment_bounds(self):
        """Tokens without offsets should fall back to the segment window."""
        merged_tokens = [
            {"text": "foo", "offsets": {"from": None, "to": None}, "p": 0.9},
        ]

        words = _build_words_from_tokens(merged_tokens, "foo", 1.0, 2.0)
        assert words[0]["start"] == 1.0
        assert words[0]["end"] == 2.0

    def test_word_validation_failure_raises(self):
        """Missing characters should trigger the validation guard."""
        merged_tokens = [
            {"text": "fo", "offsets": {"from": 0, "to": 100}, "p": 0.9},
        ]

        with pytest.raises(WhisperCppConversionError):
            _build_words_from_tokens(merged_tokens, "foo", 0.0, 0.5)


class TestConvertWhisperCppIntegration:
    """Integration-style tests that exercise end-to-end conversion."""

    def test_convert_whisper_cpp_canonicalizes_segments(self):
        seg1_text = "mý ahoj"
        seg1_raw = _latin1_mojibake(seg1_text)
        seg1 = {
            "offsets": {"from": 100, "to": 900},
            "text": seg1_raw,
            "tokens": [
                {"text": "[_BEG_]", "offsets": {"from": 0, "to": 0}, "p": 0.99},
                {"text": "m", "offsets": {"from": 0, "to": 100}, "p": 0.9},
                {"text": "Ã", "offsets": {"from": 100, "to": 150}, "p": 0.8},
                {"text": "½", "offsets": {"from": 150, "to": 200}, "p": 0.7},
                {"text": " ahoj", "offsets": {"from": 200, "to": 600}, "p": 0.95},
                {"text": "[_TT_25]", "offsets": {"from": 600, "to": 600}, "p": 0.25},
            ],
        }

        seg2_text = "A\nB"
        seg2 = {
            "offsets": {"from": 900, "to": 1500},
            "text": seg2_text,
            "tokens": [
                {"text": "A", "offsets": {"from": 900, "to": 1100}, "p": 0.8},
                {"text": "\n", "offsets": {"from": 1100, "to": 1110}, "p": 0.4},
                {"text": "B", "offsets": {"from": 1110, "to": 1500}, "p": 0.7},
                {"text": "[_TT_45]", "offsets": {"from": 1500, "to": 1500}, "p": 0.2},
            ],
        }

        payload = {
            "transcription": [seg1, seg2],
            "params": {"model": "ggml-large-v3", "temperature": 0},
            "result": {"audio": "sample.wav", "language": "cs"},
            "model": {"name": "ggml-large-v3"},
            "systeminfo": {"whisper_cpp_git": "abc123"},
        }

        converted = convert_whisper_cpp(payload, source_encoding="latin-1", duration_seconds=1.5)
        segments = converted["segments"]

        assert len(segments) == 2
        assert segments[0]["text"] == seg1_text
        assert [w["word"] for w in segments[0]["words"]] == ["mý", "ahoj"]
        # Normalized timestamps should span the segment window
        assert segments[0]["words"][0]["start"] == pytest.approx(0.1, abs=1e-6)
        assert segments[0]["words"][1]["end"] == pytest.approx(0.9, abs=1e-6)

        assert segments[1]["text"] == seg2_text
        assert [w["word"] for w in segments[1]["words"]] == ["A", "B"]
        assert segments[1]["words"][1]["end"] == pytest.approx(1.5, abs=1e-6)

        meta = converted["meta"]
        assert meta["backend"] == "whisper.cpp"
        assert meta["audio_filepath"] == "sample.wav"
        assert meta["generation_params"]["language"] == "cs"
        assert meta["model"] == "ggml-large-v3"
