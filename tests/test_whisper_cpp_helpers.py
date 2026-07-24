"""Test helper functions for whisper.cpp conversion.

These tests cover utility functions that are critical for correct
timestamp conversion, confidence calculation, and validation.
"""

from __future__ import annotations

import pytest

from besedy.cli.convert_whisper_cpp import (
    WhisperCppConversionError,
    _create_word_from_token_group,
    _mean,
    _ms_to_seconds,
    _normalize_token_timestamp,
    _validate_words_match_segment,
)


class TestTimestampConversion:
    """Test millisecond to second conversion."""

    def test_none_input(self):
        """None should return None."""
        assert _ms_to_seconds(None) is None

    @pytest.mark.parametrize(
        "ms,expected",
        [
            (0, 0.0),
            (1000, 1.0),
            (1500, 1.5),
            (123456, 123.456),
            (999, 0.999),
        ],
    )
    def test_integer_conversion(self, ms, expected):
        """Test conversion from integer milliseconds."""
        assert _ms_to_seconds(ms) == pytest.approx(expected)

    @pytest.mark.parametrize(
        "ms,expected",
        [
            (1234.56, 1.234560),
            (0.0, 0.0),
            (999.999, 0.999999),
        ],
    )
    def test_float_conversion(self, ms, expected):
        """Test conversion from float milliseconds."""
        assert _ms_to_seconds(ms) == pytest.approx(expected, abs=1e-6)

    def test_precision_rounding(self):
        """Test that output is rounded to 6 decimal places."""
        # 1234.5678901 ms should round to 1.234568 seconds
        result = _ms_to_seconds(1234.5678901)
        assert result == pytest.approx(1.234568, abs=1e-7)

    def test_negative_values(self):
        """Test handling of negative milliseconds (edge case)."""
        # Should still convert, even if semantically odd
        assert _ms_to_seconds(-1000) == pytest.approx(-1.0)


class TestMean:
    """Test confidence averaging function."""

    def test_empty_iterable(self):
        """Empty list should return None."""
        assert _mean([]) is None

    def test_all_none_values(self):
        """All None values should return None."""
        assert _mean([None, None, None]) is None

    def test_all_nan_values(self):
        """All NaN values should return None."""
        assert _mean([float("nan"), float("nan")]) is None

    def test_single_value(self):
        """Single value should return that value."""
        assert _mean([5.0]) == 5.0

    @pytest.mark.parametrize(
        "values,expected",
        [
            ([1.0, 2.0, 3.0], 2.0),
            ([0.0, 0.0, 0.0], 0.0),
            ([0.5, 0.5], 0.5),
            ([1.0, 2.0, 3.0, 4.0, 5.0], 3.0),
            ([0.9, 0.8, 0.85], 0.85),
        ],
    )
    def test_normal_averaging(self, values, expected):
        """Test averaging of normal numeric values."""
        assert _mean(values) == pytest.approx(expected)

    def test_mixed_with_none(self):
        """None values should be filtered out."""
        # [1.0, None, 3.0] -> average of [1.0, 3.0] = 2.0
        assert _mean([1.0, None, 3.0]) == pytest.approx(2.0)

    def test_mixed_with_nan(self):
        """NaN values should be filtered out."""
        # [1.0, NaN, 3.0] -> average of [1.0, 3.0] = 2.0
        assert _mean([1.0, float("nan"), 3.0]) == pytest.approx(2.0)

    def test_mixed_none_and_nan(self):
        """Both None and NaN should be filtered out."""
        assert _mean([1.0, None, float("nan"), 3.0]) == pytest.approx(2.0)

    def test_negative_values(self):
        """Should handle negative values correctly."""
        assert _mean([-1.0, -2.0, -3.0]) == pytest.approx(-2.0)

    def test_very_small_values(self):
        """Should handle very small floating point values."""
        assert _mean([1e-10, 2e-10, 3e-10]) == pytest.approx(2e-10)


class TestTimestampNormalization:
    """Test token timestamp normalization to segment range."""

    def test_value_ms_none(self):
        """None value_ms should return None."""
        assert _normalize_token_timestamp(None, 100, 200, 0.0, 1.0) is None

    def test_token_start_ms_none(self):
        """None token_start_ms should return None."""
        assert _normalize_token_timestamp(150, None, 200, 0.0, 1.0) is None

    def test_token_end_ms_none(self):
        """None token_end_ms should return None."""
        assert _normalize_token_timestamp(150, 100, None, 0.0, 1.0) is None

    @pytest.mark.parametrize(
        "token_start,token_end",
        [
            (100, 100),  # Zero duration
            (200, 100),  # Negative duration (end before start)
            (100, 99),  # Negative duration
        ],
    )
    def test_invalid_duration(self, token_start, token_end):
        """Zero or negative duration should return None."""
        assert _normalize_token_timestamp(150, token_start, token_end, 0.0, 1.0) is None

    def test_midpoint_projection(self):
        """Value at midpoint of token range should map to midpoint of segment."""
        # Token range: [100, 200], value=150 (midpoint)
        # Segment range: [5.0, 9.0], expected=7.0 (midpoint)
        result = _normalize_token_timestamp(150, 100, 200, 5.0, 9.0)
        assert result == pytest.approx(7.0)

    def test_start_projection(self):
        """Value at token start should map to segment start."""
        # value_ms = token_start_ms
        result = _normalize_token_timestamp(100, 100, 200, 5.0, 9.0)
        assert result == pytest.approx(5.0)

    def test_end_projection(self):
        """Value at token end should map to segment end."""
        # value_ms = token_end_ms
        result = _normalize_token_timestamp(200, 100, 200, 5.0, 9.0)
        assert result == pytest.approx(9.0)

    def test_quarter_point(self):
        """Value at 25% should map to 25% of segment."""
        # Token: [100, 200], value=125 (25%)
        # Segment: [0.0, 4.0], expected=1.0 (25%)
        result = _normalize_token_timestamp(125, 100, 200, 0.0, 4.0)
        assert result == pytest.approx(1.0)

    def test_three_quarter_point(self):
        """Value at 75% should map to 75% of segment."""
        # Token: [100, 200], value=175 (75%)
        # Segment: [0.0, 4.0], expected=3.0 (75%)
        result = _normalize_token_timestamp(175, 100, 200, 0.0, 4.0)
        assert result == pytest.approx(3.0)

    def test_value_before_token_start(self):
        """Value before token start should clamp to segment start."""
        # value_ms < token_start_ms -> ratio clamped to 0.0
        result = _normalize_token_timestamp(50, 100, 200, 5.0, 9.0)
        assert result == pytest.approx(5.0)

    def test_value_after_token_end(self):
        """Value after token end should clamp to segment end."""
        # value_ms > token_end_ms -> ratio clamped to 1.0
        result = _normalize_token_timestamp(300, 100, 200, 5.0, 9.0)
        assert result == pytest.approx(9.0)

    def test_rounding_precision(self):
        """Result should be rounded to 6 decimal places."""
        # Use values that produce many decimals
        result = _normalize_token_timestamp(133, 100, 200, 0.0, 1.0)
        # 133 is 33% of [100, 200] -> 0.33
        assert isinstance(result, float)
        assert result == pytest.approx(0.33, abs=1e-6)

    def test_negative_segment_duration(self):
        """Negative segment duration should be treated as 0.0."""
        # segment_end < segment_start -> duration = 0.0
        result = _normalize_token_timestamp(150, 100, 200, 9.0, 5.0)
        # With duration 0.0, should map to segment_start (9.0)
        assert result == pytest.approx(9.0)

    def test_zero_segment_duration(self):
        """Zero segment duration should return segment start."""
        result = _normalize_token_timestamp(150, 100, 200, 5.0, 5.0)
        assert result == pytest.approx(5.0)


class TestWordValidation:
    """Test word-to-segment text validation."""

    def test_valid_match(self):
        """Words that match segment should not raise."""
        words = [{"word": "hello"}, {"word": "world"}]
        # Should not raise
        _validate_words_match_segment(words, "hello world")

    def test_valid_match_extra_spaces(self):
        """Extra spaces in segment should be ignored."""
        words = [{"word": "hello"}, {"word": "world"}]
        # Multiple spaces should be normalized
        _validate_words_match_segment(words, "hello   world")

    def test_valid_match_leading_trailing_spaces(self):
        """Leading/trailing spaces should be ignored."""
        words = [{"word": "hello"}, {"word": "world"}]
        _validate_words_match_segment(words, "  hello world  ")

    def test_valid_match_newlines(self):
        """Newlines should be treated as whitespace."""
        words = [{"word": "hello"}, {"word": "world"}]
        _validate_words_match_segment(words, "hello\nworld")

    def test_mismatch_missing_word(self):
        """Missing word in reconstruction should raise."""
        words = [{"word": "hello"}]
        with pytest.raises(WhisperCppConversionError) as exc_info:
            _validate_words_match_segment(words, "hello world")

        assert "Word reconstruction TEXT validation failed" in str(exc_info.value)
        assert "Expected length: 10" in str(exc_info.value)  # "helloworld"
        assert "Reconstructed length: 5" in str(exc_info.value)  # "hello"

    def test_mismatch_extra_word(self):
        """Extra word in reconstruction should raise."""
        words = [{"word": "hello"}, {"word": "world"}, {"word": "extra"}]
        with pytest.raises(WhisperCppConversionError) as exc_info:
            _validate_words_match_segment(words, "hello world")

        assert "Word reconstruction TEXT validation failed" in str(exc_info.value)

    def test_mismatch_wrong_word(self):
        """Wrong word content should raise."""
        words = [{"word": "hello"}, {"word": "universe"}]
        with pytest.raises(WhisperCppConversionError) as exc_info:
            _validate_words_match_segment(words, "hello world")

        assert "Word reconstruction TEXT validation failed" in str(exc_info.value)

    def test_empty_words(self):
        """Empty word list with non-empty segment should raise."""
        words = []
        with pytest.raises(WhisperCppConversionError) as exc_info:
            _validate_words_match_segment(words, "hello")

        assert "Word reconstruction TEXT validation failed" in str(exc_info.value)

    def test_empty_words_empty_segment(self):
        """Empty word list with empty segment should pass."""
        words = []
        # Should not raise
        _validate_words_match_segment(words, "")

    def test_czech_text(self):
        """Czech characters should be handled correctly."""
        words = [{"word": "dobrý"}, {"word": "den"}]
        _validate_words_match_segment(words, "dobrý den")


class TestCreateWordFromTokenGroup:
    """Test word creation from token groups."""

    def test_empty_token_list(self):
        """Empty token list should return None."""
        result = _create_word_from_token_group([], 0.0, 1.0, None, None)
        assert result is None

    def test_whitespace_only_token(self):
        """Token with only whitespace should return None after stripping."""
        tokens = [{"text": "   ", "offsets": {"from": 0, "to": 100}, "p": 0.9}]
        result = _create_word_from_token_group(tokens, 0.0, 1.0, None, None)
        assert result is None

    def test_simple_word(self):
        """Simple word creation from single token."""
        tokens = [{"text": "hello", "offsets": {"from": 0, "to": 100}, "p": 0.9}]
        result = _create_word_from_token_group(tokens, 0.0, 1.0, 0, 500)

        assert result is not None
        assert result["word"] == "hello"
        assert result["confidence"] == 0.9

    def test_word_with_leading_space(self):
        """Leading space should be stripped from word."""
        tokens = [{"text": " hello", "offsets": {"from": 0, "to": 100}, "p": 0.9}]
        result = _create_word_from_token_group(tokens, 0.0, 1.0, 0, 500)

        assert result["word"] == "hello"

    def test_word_with_trailing_space(self):
        """Trailing space should be stripped from word."""
        tokens = [{"text": "hello ", "offsets": {"from": 0, "to": 100}, "p": 0.9}]
        result = _create_word_from_token_group(tokens, 0.0, 1.0, 0, 500)

        assert result["word"] == "hello"

    def test_multiple_tokens(self):
        """Word from multiple tokens should concatenate."""
        tokens = [
            {"text": "hel", "offsets": {"from": 0, "to": 50}, "p": 0.9},
            {"text": "lo", "offsets": {"from": 50, "to": 100}, "p": 0.85},
        ]
        result = _create_word_from_token_group(tokens, 0.0, 1.0, 0, 500)

        assert result["word"] == "hello"
        # Start from first token, end from last token
        assert result["start"] <= result["end"]

    def test_confidence_averaging(self):
        """Confidence should be averaged across tokens."""
        tokens = [
            {"text": "hel", "offsets": {"from": 0, "to": 50}, "p": 0.8},
            {"text": "lo", "offsets": {"from": 50, "to": 100}, "p": 0.9},
        ]
        result = _create_word_from_token_group(tokens, 0.0, 1.0, 0, 500)

        assert result["confidence"] == pytest.approx(0.85)

    def test_confidence_with_none_values(self):
        """None confidence values should be filtered out."""
        tokens = [
            {"text": "hel", "offsets": {"from": 0, "to": 50}, "p": 0.8},
            {"text": "lo", "offsets": {"from": 50, "to": 100}, "p": None},
        ]
        result = _create_word_from_token_group(tokens, 0.0, 1.0, 0, 500)

        assert result["confidence"] == 0.8

    def test_all_confidence_none(self):
        """All None confidence should result in None."""
        tokens = [
            {"text": "hello", "offsets": {"from": 0, "to": 100}, "p": None},
        ]
        result = _create_word_from_token_group(tokens, 0.0, 1.0, 0, 500)

        assert result["confidence"] is None

    def test_missing_offsets(self):
        """Missing offsets dict should fall back to segment boundaries."""
        # Empty offsets dict is the valid case, not None
        tokens = [{"text": "hello", "offsets": {}, "p": 0.9}]
        result = _create_word_from_token_group(tokens, 5.0, 9.0, None, None)

        assert result is not None
        assert result["word"] == "hello"
        # Should use segment start/end when offsets are missing
        assert result["start"] == 5.0
        assert result["end"] == 9.0

    def test_timestamp_clamping(self):
        """Timestamps should be clamped to segment boundaries."""
        tokens = [{"text": "hello", "offsets": {"from": -100, "to": 9999}, "p": 0.9}]
        result = _create_word_from_token_group(tokens, 0.0, 1.0, 0, 500)

        # Should be clamped to [0.0, 1.0]
        assert result["start"] >= 0.0
        assert result["end"] <= 1.0

    def test_end_before_start_correction(self):
        """If end < start, should correct to end = start."""
        tokens = [
            {"text": "hel", "offsets": {"from": 100, "to": 50}, "p": 0.9},  # Reversed
        ]
        result = _create_word_from_token_group(tokens, 0.0, 1.0, 0, 500)

        # After correction, end should equal start
        assert result["end"] >= result["start"]
