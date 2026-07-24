"""Advanced test cases for whisper.cpp conversion.

These tests cover edge cases like 4-byte UTF-8 characters (emoji),
debug mode, and complex mixed-encoding scenarios.
"""

from __future__ import annotations

import pytest

from besedy.cli.convert_whisper_cpp import (
    WhisperCppConversionError,
    _build_words_from_tokens,
    _merge_broken_utf8_tokens,
)


class TestFourByteUTF8:
    """Test 4-byte UTF-8 character handling (emoji)."""

    def test_single_emoji_split_across_tokens(self):
        """Test 4-byte UTF-8 character split across tokens (😀 = F0 9F 98 80)."""
        # Emoji: 😀 (grinning face)
        segment_bytes = bytes([0xF0, 0x9F, 0x98, 0x80])
        segment_text_mojibake = segment_bytes.decode("latin-1")

        tokens = [
            {"text": "ð", "offsets": {"from": 0, "to": 100}, "p": 0.7},  # 0xF0
            {"text": "\x9f", "offsets": {"from": 100, "to": 150}, "p": 0.7},  # 0x9F
            {"text": "\x98", "offsets": {"from": 150, "to": 200}, "p": 0.7},  # 0x98
            {"text": "\x80", "offsets": {"from": 200, "to": 250}, "p": 0.7},  # 0x80
        ]

        result = _merge_broken_utf8_tokens(
            tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
        )

        assert len(result) == 1
        assert result[0]["text"] == "😀"
        assert result[0]["offsets"]["from"] == 0
        assert result[0]["offsets"]["to"] == 250
        # Average confidence across 4 tokens
        assert result[0]["p"] == 0.7

    def test_emoji_with_text(self):
        """Test emoji mixed with ASCII text."""
        # Text: "hi😀ok" = [0x68, 0x69, 0xF0, 0x9F, 0x98, 0x80, 0x6F, 0x6B]
        segment_bytes = bytes([0x68, 0x69, 0xF0, 0x9F, 0x98, 0x80, 0x6F, 0x6B])
        segment_text_mojibake = segment_bytes.decode("latin-1")

        tokens = [
            {"text": "hi", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {
                "text": "ð\x9f\x98\x80",
                "offsets": {"from": 100, "to": 200},
                "p": 0.8,
            },  # Emoji as one token
            {"text": "ok", "offsets": {"from": 200, "to": 300}, "p": 0.85},
        ]

        result = _merge_broken_utf8_tokens(
            tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
        )

        reconstructed = "".join(t["text"] for t in result)
        assert reconstructed == "hi😀ok"

    def test_multiple_emoji(self):
        """Test multiple emoji characters."""
        # 😀🎉 = [0xF0, 0x9F, 0x98, 0x80, 0xF0, 0x9F, 0x8E, 0x89]
        segment_bytes = bytes([0xF0, 0x9F, 0x98, 0x80, 0xF0, 0x9F, 0x8E, 0x89])
        segment_text_mojibake = segment_bytes.decode("latin-1")

        tokens = [
            {"text": "ð\x9f\x98\x80", "offsets": {"from": 0, "to": 200}, "p": 0.8},
            {"text": "ð\x9f\x8e\x89", "offsets": {"from": 200, "to": 400}, "p": 0.85},
        ]

        result = _merge_broken_utf8_tokens(
            tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
        )

        reconstructed = "".join(t["text"] for t in result)
        assert reconstructed == "😀🎉"
        assert len(result) == 2


class TestMixedMultibyteSequences:
    """Test complex mixed UTF-8 byte sequences."""

    def test_one_two_three_byte_sequence(self):
        """Test mixed 1-2-3 byte UTF-8 sequence: 'a€ý'."""
        # a=0x61 (1-byte), €=0xE2 0x82 0xAC (3-byte), ý=0xC3 0xBD (2-byte)
        segment_bytes = bytes([0x61, 0xE2, 0x82, 0xAC, 0xC3, 0xBD])
        segment_text_mojibake = segment_bytes.decode("latin-1")

        tokens = [
            {"text": "a", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "â\x82¬", "offsets": {"from": 100, "to": 200}, "p": 0.8},
            {"text": "Ã½", "offsets": {"from": 200, "to": 300}, "p": 0.85},
        ]

        result = _merge_broken_utf8_tokens(
            tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
        )

        reconstructed = "".join(t["text"] for t in result)
        assert reconstructed == "a€ý"

    def test_all_four_byte_lengths(self):
        """Test sequence with 1, 2, 3, and 4 byte UTF-8 characters."""
        # a (1), ý (2), € (3), 😀 (4)
        segment_bytes = bytes(
            [
                0x61,  # a (1-byte)
                0xC3,
                0xBD,  # ý (2-byte)
                0xE2,
                0x82,
                0xAC,  # € (3-byte)
                0xF0,
                0x9F,
                0x98,
                0x80,  # 😀 (4-byte)
            ]
        )
        segment_text_mojibake = segment_bytes.decode("latin-1")

        tokens = [
            {"text": "a", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "Ã½", "offsets": {"from": 100, "to": 200}, "p": 0.85},
            {"text": "â\x82¬", "offsets": {"from": 200, "to": 300}, "p": 0.8},
            {"text": "ð\x9f\x98\x80", "offsets": {"from": 300, "to": 400}, "p": 0.75},
        ]

        result = _merge_broken_utf8_tokens(
            tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
        )

        reconstructed = "".join(t["text"] for t in result)
        assert reconstructed == "aý€😀"


class TestDebugMode:
    """Test debug output functionality."""

    def test_debug_output_generated(self, capsys):
        """Test that debug mode generates output."""
        segment_text = "hi"
        tokens = [
            {"text": "h", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "i", "offsets": {"from": 100, "to": 200}, "p": 0.85},
        ]

        _merge_broken_utf8_tokens(tokens, segment_text, source_encoding="utf-8", debug=True)

        captured = capsys.readouterr()
        assert "=== DEBUG: Token Merging ===" in captured.out
        assert "Ground truth bytes" in captured.out
        assert "Character map" in captured.out

    def test_debug_shows_special_tokens(self, capsys):
        """Test debug mode shows special token filtering."""
        segment_text = "hi"
        tokens = [
            {"text": "[_BEG_]", "offsets": {"from": 0, "to": 0}, "p": 0.9},
            {"text": "h", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "i", "offsets": {"from": 100, "to": 200}, "p": 0.85},
        ]

        _merge_broken_utf8_tokens(tokens, segment_text, source_encoding="utf-8", debug=True)

        captured = capsys.readouterr()
        assert "SPECIAL [_BEG_]" in captured.out
        assert "skipped" in captured.out

    def test_debug_shows_merged_tokens(self, capsys):
        """Test debug mode shows token merging for multi-byte UTF-8."""
        # Czech text "mý" where ý is split
        segment_text_mojibake = "mÃ½"

        tokens = [
            {"text": "m", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": "Ã", "offsets": {"from": 100, "to": 150}, "p": 0.8},
            {"text": "½", "offsets": {"from": 150, "to": 200}, "p": 0.8},
        ]

        _merge_broken_utf8_tokens(
            tokens, segment_text_mojibake, source_encoding="latin-1", debug=True
        )

        captured = capsys.readouterr()
        assert "MERGED:" in captured.out
        assert "2 tokens" in captured.out


class TestEdgeCasesWordBuilding:
    """Test edge cases in word building from tokens."""

    def test_whitespace_only_separators(self):
        """Test tokens that are only whitespace."""
        merged_tokens = [
            {"text": "hello", "offsets": {"from": 0, "to": 300}, "p": 0.9},
            {"text": "  ", "offsets": {"from": 300, "to": 320}, "p": 0.8},  # Two spaces
            {"text": " world", "offsets": {"from": 320, "to": 600}, "p": 0.85},
        ]

        words = _build_words_from_tokens(merged_tokens, "hello  world", 0.0, 0.6)
        assert [w["word"] for w in words] == ["hello", "world"]

    def test_tab_as_word_boundary(self):
        """Test tab character splits words."""
        merged_tokens = [
            {"text": "foo", "offsets": {"from": 0, "to": 300}, "p": 0.9},
            {"text": "\t", "offsets": {"from": 300, "to": 320}, "p": 0.8},
            {"text": " bar", "offsets": {"from": 320, "to": 600}, "p": 0.85},
        ]

        words = _build_words_from_tokens(merged_tokens, "foo\tbar", 0.0, 0.6)
        assert [w["word"] for w in words] == ["foo", "bar"]

    def test_multiple_consecutive_whitespace_tokens(self):
        """Test multiple whitespace tokens in a row."""
        merged_tokens = [
            {"text": "a", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": " ", "offsets": {"from": 100, "to": 110}, "p": 0.8},
            {"text": " ", "offsets": {"from": 110, "to": 120}, "p": 0.8},
            {"text": " b", "offsets": {"from": 120, "to": 200}, "p": 0.85},
        ]

        words = _build_words_from_tokens(merged_tokens, "a   b", 0.0, 0.2)
        assert [w["word"] for w in words] == ["a", "b"]

    def test_mixed_whitespace_types(self):
        """Test space, tab, and newline as word boundaries."""
        merged_tokens = [
            {"text": "a", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            {"text": " ", "offsets": {"from": 100, "to": 110}, "p": 0.8},
            {"text": " b", "offsets": {"from": 110, "to": 200}, "p": 0.85},
            {"text": "\t", "offsets": {"from": 200, "to": 210}, "p": 0.8},
            {"text": " c", "offsets": {"from": 210, "to": 300}, "p": 0.87},
            {"text": "\n", "offsets": {"from": 300, "to": 310}, "p": 0.8},
            {"text": " d", "offsets": {"from": 310, "to": 400}, "p": 0.88},
        ]

        words = _build_words_from_tokens(merged_tokens, "a b\tc\nd", 0.0, 0.4)
        assert [w["word"] for w in words] == ["a", "b", "c", "d"]

    def test_empty_merged_tokens(self):
        """Test empty merged tokens list."""
        words = _build_words_from_tokens([], "", 0.0, 1.0)
        assert words == []


class TestEncodingErrorPaths:
    """Test error handling in encoding/decoding."""

    def test_utf8_decode_error_in_latin1_mode(self):
        """Test invalid UTF-8 bytes when using latin-1 encoding."""
        # Create invalid UTF-8 sequence: 0xC3 followed by 0xFF (not valid continuation)
        segment_text_mojibake = "Ã\xff"  # 0xC3 0xFF - invalid UTF-8

        tokens = [
            {"text": "Ã", "offsets": {"from": 0, "to": 100}, "p": 0.8},
            {"text": "\xff", "offsets": {"from": 100, "to": 200}, "p": 0.8},
        ]

        with pytest.raises(WhisperCppConversionError) as exc_info:
            _merge_broken_utf8_tokens(
                tokens, segment_text_mojibake, source_encoding="latin-1", debug=False
            )

        assert "Failed to decode segment bytes as UTF-8" in str(exc_info.value)

    def test_byte_length_mismatch(self):
        """Test when total token bytes don't match ground truth length."""
        segment_text = "hello world"

        tokens = [
            {"text": "hello", "offsets": {"from": 0, "to": 100}, "p": 0.9},
            # Missing ' world' - only 5 bytes instead of 11
        ]

        with pytest.raises(WhisperCppConversionError) as exc_info:
            _merge_broken_utf8_tokens(tokens, segment_text, source_encoding="utf-8", debug=False)

        assert "Token bytes length" in str(exc_info.value)
        assert "doesn't match ground truth" in str(exc_info.value)

    def test_byte_content_mismatch(self):
        """Test when token bytes don't match ground truth content."""
        segment_text = "hello"

        tokens = [
            {"text": "world", "offsets": {"from": 0, "to": 100}, "p": 0.9},  # Wrong content
        ]

        with pytest.raises(WhisperCppConversionError) as exc_info:
            _merge_broken_utf8_tokens(tokens, segment_text, source_encoding="utf-8", debug=False)

        assert "Token bytes don't match ground truth bytes" in str(exc_info.value)


@pytest.fixture
def sample_czech_tokens():
    """Fixture providing sample Czech text tokens."""
    return [
        {"text": "d", "offsets": {"from": 0, "to": 50}, "p": 0.9},
        {"text": "ob", "offsets": {"from": 50, "to": 100}, "p": 0.85},
        {"text": "rý", "offsets": {"from": 100, "to": 150}, "p": 0.88},
        {"text": " ", "offsets": {"from": 150, "to": 160}, "p": 0.95},
        {"text": "den", "offsets": {"from": 160, "to": 200}, "p": 0.92},
    ]


@pytest.fixture
def sample_emoji_tokens():
    """Fixture providing sample emoji tokens."""
    # Text: "hello 😀 world"
    segment_bytes = b"hello " + bytes([0xF0, 0x9F, 0x98, 0x80]) + b" world"
    segment_mojibake = segment_bytes.decode("latin-1")

    tokens = [
        {"text": "hello", "offsets": {"from": 0, "to": 100}, "p": 0.9},
        {"text": " ", "offsets": {"from": 100, "to": 110}, "p": 0.95},
        {"text": "ð\x9f\x98\x80", "offsets": {"from": 110, "to": 200}, "p": 0.8},
        {"text": " ", "offsets": {"from": 200, "to": 210}, "p": 0.95},
        {"text": "world", "offsets": {"from": 210, "to": 300}, "p": 0.92},
    ]

    return segment_mojibake, tokens


class TestFixtures:
    """Test using fixtures to reduce duplication."""

    def test_czech_text_fixture(self, sample_czech_tokens):
        """Test using Czech text fixture."""
        result = _merge_broken_utf8_tokens(
            sample_czech_tokens, "dobrý den", source_encoding="utf-8", debug=False
        )

        text = "".join(t["text"] for t in result)
        assert text == "dobrý den"

    def test_emoji_text_fixture(self, sample_emoji_tokens):
        """Test using emoji text fixture."""
        segment_mojibake, tokens = sample_emoji_tokens

        result = _merge_broken_utf8_tokens(
            tokens, segment_mojibake, source_encoding="latin-1", debug=False
        )

        text = "".join(t["text"] for t in result)
        assert text == "hello 😀 world"
