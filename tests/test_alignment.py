"""Tests for lib/analysis/alignment.py - word-level alignment functions."""

from __future__ import annotations

import math

import pytest

from besedy.lib.analysis.alignment import (
    PairMatchStats,
    Word,
    analyse_word_overlap,
    normalize_word,
    pairwise_match,
)


class TestWord:
    """Tests for Word dataclass."""

    def test_word_creation(self):
        """Create Word with all attributes."""
        word = Word(start=0.0, end=1.0, text="Hello", confidence=0.95)
        assert word.start == 0.0
        assert word.end == 1.0
        assert word.text == "Hello"
        assert word.confidence == 0.95

    def test_word_duration(self):
        """Word.duration property returns correct value."""
        word = Word(start=1.0, end=3.5, text="test", confidence=None)
        assert word.duration == 2.5

    def test_word_duration_negative(self):
        """Word.duration handles negative duration (end < start)."""
        word = Word(start=5.0, end=3.0, text="test", confidence=None)
        assert word.duration == 0.0  # max(0, -2) = 0


class TestNormalizeWord:
    """Tests for normalize_word function."""

    def test_lowercase(self):
        """Convert to lowercase."""
        assert normalize_word("HELLO") == "hello"

    def test_strip_punctuation(self):
        """Strip common punctuation."""
        assert normalize_word("Hello,") == "hello"
        assert normalize_word("world!") == "world"
        assert normalize_word('"quoted"') == "quoted"
        assert normalize_word("(parentheses)") == "parentheses"

    def test_complex_punctuation(self):
        """Handle complex punctuation combinations."""
        assert normalize_word("...test...") == "test"
        assert normalize_word("—dash—") == "dash"

    def test_empty_string(self):
        """Handle empty string."""
        assert normalize_word("") == ""


class TestPairwiseMatch:
    """Tests for pairwise_match function."""

    def test_exact_match(self, sample_words_a):
        """Perfect alignment when words match exactly."""
        # Same words matched against themselves
        stats = pairwise_match(sample_words_a, sample_words_a, tolerance=0.1)

        assert stats.matches == 3
        assert stats.unmatched_a == 0
        assert stats.unmatched_b == 0
        assert stats.text_matches == 3

    def test_within_tolerance(self, sample_words_a, sample_words_b):
        """Match words within tolerance threshold."""
        # sample_words_b is offset by 0.05s from sample_words_a
        stats = pairwise_match(sample_words_a, sample_words_b, tolerance=0.1)

        assert stats.matches == 3
        assert stats.unmatched_a == 0
        assert stats.unmatched_b == 0

    def test_outside_tolerance(self, sample_words_a, sample_words_b):
        """No match when words outside tolerance."""
        # Very tight tolerance should miss the 0.05s offset
        stats = pairwise_match(sample_words_a, sample_words_b, tolerance=0.01)

        assert stats.matches < 3
        assert stats.unmatched_a > 0

    def test_different_word_count(self, sample_words_a, sample_words_misaligned):
        """Handle different word counts between sequences."""
        # sample_words_misaligned has 0.5s offset, use larger tolerance
        stats = pairwise_match(sample_words_a, sample_words_misaligned, tolerance=0.6)

        # Some words should match with larger tolerance
        assert stats.matches >= 1
        # At least one unmatched due to different text ("world" vs "there")
        assert stats.unmatched_a >= 1 or stats.unmatched_b >= 1

    def test_empty_sequences(self):
        """Handle empty word sequences."""
        stats = pairwise_match([], [], tolerance=0.1)

        assert stats.matches == 0
        assert stats.unmatched_a == 0
        assert stats.unmatched_b == 0

    def test_coverage_properties(self, sample_words_a, sample_words_b):
        """Verify coverage property calculations."""
        stats = pairwise_match(sample_words_a, sample_words_b, tolerance=0.1)

        # With 3 matches out of 3 words each, coverage should be 1.0
        assert stats.coverage_a == pytest.approx(1.0)
        assert stats.coverage_b == pytest.approx(1.0)

    def test_signed_diffs_recorded(self, sample_words_a, sample_words_b):
        """Verify signed differences are recorded."""
        stats = pairwise_match(sample_words_a, sample_words_b, tolerance=0.1)

        # Should have signed diffs for each match
        assert len(stats.start_diffs_signed) == stats.matches
        assert len(stats.end_diffs_signed) == stats.matches

        # Differences should be small (0.05s offset)
        for diff in stats.start_diffs_signed:
            assert abs(diff) < 0.1


class TestAnalyseWordOverlap:
    """Tests for analyse_word_overlap function."""

    def test_perfect_overlap(self, sample_words_a):
        """Perfect overlap when words match exactly."""
        result = analyse_word_overlap(sample_words_a, sample_words_a)

        # Each word should overlap with exactly one word
        assert all(c == 1 for c in result["counts_a"])
        assert all(c == 1 for c in result["counts_b"])
        assert result["overlap_duration"] > 0

    def test_partial_overlap(self, sample_words_a, sample_words_b):
        """Partial overlap with slightly offset words."""
        result = analyse_word_overlap(sample_words_a, sample_words_b)

        # Should still have overlap due to close timing
        assert result["overlap_duration"] > 0
        # Most words should overlap
        assert sum(result["counts_a"]) >= len(sample_words_a)

    def test_no_overlap(self, sample_words_a):
        """No overlap when word sequences don't intersect."""
        # Create words that don't overlap temporally
        from besedy.lib.analysis.alignment import Word

        far_words = [
            Word(start=100.0, end=101.0, text="far", confidence=None),
            Word(start=101.0, end=102.0, text="away", confidence=None),
        ]

        result = analyse_word_overlap(sample_words_a, far_words)

        assert result["overlap_duration"] == 0.0
        assert all(c == 0 for c in result["counts_a"])
        assert all(c == 0 for c in result["counts_b"])

    def test_empty_sequences(self):
        """Handle empty word sequences."""
        result = analyse_word_overlap([], [])

        assert result["overlap_duration"] == 0.0
        assert result["counts_a"] == []
        assert result["counts_b"] == []


class TestPairMatchStats:
    """Tests for PairMatchStats dataclass."""

    def test_coverage_with_zero_total(self):
        """Coverage returns nan when no words."""
        stats = PairMatchStats(
            matches=0,
            unmatched_a=0,
            unmatched_b=0,
            start_diffs_abs=[],
            end_diffs_abs=[],
            start_diffs_signed=[],
            end_diffs_signed=[],
            text_matches=0,
            total_pairs=0,
        )

        assert math.isnan(stats.coverage_a)
        assert math.isnan(stats.coverage_b)

    def test_coverage_calculation(self):
        """Coverage calculated correctly."""
        stats = PairMatchStats(
            matches=8,
            unmatched_a=2,
            unmatched_b=4,
            start_diffs_abs=[],
            end_diffs_abs=[],
            start_diffs_signed=[],
            end_diffs_signed=[],
            text_matches=7,
            total_pairs=8,
        )

        # coverage_a = 8 / (8 + 2) = 0.8
        assert stats.coverage_a == pytest.approx(0.8)
        # coverage_b = 8 / (8 + 4) = 0.667
        assert stats.coverage_b == pytest.approx(8 / 12)
