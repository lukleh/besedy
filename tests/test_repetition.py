"""Tests for lib/analysis/repetition.py - repetition detection functions."""

from __future__ import annotations

from besedy.lib.analysis.repetition import (
    RepeatFinding,
    detect_all_repetitions,
    find_character_repeats,
    find_segment_repeats,
    find_word_repeats,
)


class TestFindWordRepeats:
    """Tests for find_word_repeats function."""

    def test_basic_word_repeat(self, sample_repeated_text):
        """Detect simple word repetitions like 'Hello Hello Hello'."""
        findings = find_word_repeats(sample_repeated_text, min_repeats=2)

        # Should find "Hello" repeated 3 times
        hello_findings = [f for f in findings if "Hello" in f.sequence]
        assert len(hello_findings) >= 1
        assert hello_findings[0].repeats >= 3

    def test_double_word_repeat(self, sample_repeated_text):
        """Detect double word repetitions like 'quick quick'."""
        findings = find_word_repeats(sample_repeated_text, min_repeats=2)

        # Should find "quick" repeated 2 times
        quick_findings = [f for f in findings if "quick" in f.sequence]
        assert len(quick_findings) >= 1
        assert quick_findings[0].repeats >= 2

    def test_empty_text(self):
        """Handle empty text gracefully."""
        findings = find_word_repeats("", min_repeats=2)
        assert findings == []

    def test_no_repeats(self):
        """Return empty list when no repetitions exist."""
        findings = find_word_repeats("The quick brown fox jumps", min_repeats=2)
        # No consecutive word repeats
        assert len([f for f in findings if f.kind == "words"]) == 0

    def test_single_word_text(self):
        """Handle single word text."""
        findings = find_word_repeats("Hello", min_repeats=2)
        assert findings == []

    def test_min_repeats_threshold(self):
        """Respect min_repeats threshold."""
        text = "word word word"  # 3 repeats

        # Should find with min_repeats=2
        findings_2 = find_word_repeats(text, min_repeats=2)
        assert len(findings_2) >= 1

        # Should find with min_repeats=3
        findings_3 = find_word_repeats(text, min_repeats=3)
        assert len(findings_3) >= 1

        # Should NOT find with min_repeats=4
        findings_4 = find_word_repeats(text, min_repeats=4)
        assert len(findings_4) == 0

    def test_normalizes_case_and_punctuation(self):
        """Match repetitions across case and edge punctuation variants."""
        text = "Hello, hello HELLO!"
        findings = find_word_repeats(text, min_repeats=2)
        assert any(f.length == 1 and f.repeats >= 3 for f in findings)


class TestFindCharacterRepeats:
    """Tests for find_character_repeats function."""

    def test_character_repeat(self):
        """Detect repeated character patterns."""
        text = "abababab test"  # "ab" repeated 4 times
        findings = find_character_repeats(text, min_len=2, max_len=4, min_repeats=2)

        ab_findings = [f for f in findings if f.sequence == "ab"]
        assert len(ab_findings) >= 1
        assert ab_findings[0].repeats >= 4

    def test_empty_text(self):
        """Handle empty text gracefully."""
        findings = find_character_repeats("", min_repeats=2)
        assert findings == []

    def test_whitespace_only(self):
        """Skip whitespace-only repeats."""
        text = "hello    world"  # Multiple spaces
        findings = find_character_repeats(text, min_len=2, min_repeats=2)

        # Should not report space repeats
        space_findings = [f for f in findings if f.sequence.strip() == ""]
        assert len(space_findings) == 0


class TestFindSegmentRepeats:
    """Tests for find_segment_repeats function."""

    def test_segment_repeat(self, sample_repeated_segments):
        """Detect repeated segment sequences."""
        findings = find_segment_repeats(sample_repeated_segments, min_repeats=2)

        # Should find "Hello" segment repeated 3 times
        assert len(findings) >= 1
        hello_finding = findings[0]
        assert hello_finding.repeats >= 3
        assert "Hello" in hello_finding.sequence

    def test_empty_segments(self):
        """Handle empty segment list gracefully."""
        findings = find_segment_repeats([], min_repeats=2)
        assert findings == []

    def test_single_segment(self):
        """Handle single segment gracefully."""
        segments = [{"text": "Hello", "start": 0.0, "end": 1.0}]
        findings = find_segment_repeats(segments, min_repeats=2)
        assert findings == []

    def test_no_repeated_segments(self):
        """Return empty when no segment repetitions."""
        segments = [
            {"text": "Hello", "start": 0.0, "end": 1.0},
            {"text": "World", "start": 1.0, "end": 2.0},
            {"text": "Test", "start": 2.0, "end": 3.0},
        ]
        findings = find_segment_repeats(segments, min_repeats=2)
        assert findings == []

    def test_segment_repeat_normalizes_case_and_punctuation(self):
        """Detect repeated segment text despite case/punctuation differences."""
        segments = [
            {"text": "Ahoj!", "start": 0.0, "end": 1.0},
            {"text": "ahoj", "start": 1.0, "end": 2.0},
            {"text": "AHOJ.", "start": 2.0, "end": 3.0},
        ]
        findings = find_segment_repeats(segments, min_repeats=2)
        assert len(findings) >= 1
        assert findings[0].repeats >= 3


class TestDetectAllRepetitions:
    """Tests for detect_all_repetitions function."""

    def test_returns_all_types(self, sample_transcript_json):
        """Return dictionary with chars, words, segments keys."""
        results = detect_all_repetitions(sample_transcript_json)

        assert "chars" in results
        assert "words" in results
        assert "segments" in results
        assert isinstance(results["chars"], list)
        assert isinstance(results["words"], list)
        assert isinstance(results["segments"], list)

    def test_empty_transcript(self):
        """Handle empty transcript gracefully."""
        results = detect_all_repetitions({"segments": []})

        assert results["chars"] == []
        assert results["words"] == []
        assert results["segments"] == []

    def test_ignores_non_dict_segment_rows(self):
        """Handle malformed segment entries without crashing."""
        results = detect_all_repetitions(
            {
                "segments": [
                    {"text": "loop loop"},
                    "bad-row",
                    None,
                    {"text": "loop loop"},
                ]
            }
        )
        assert isinstance(results["chars"], list)
        assert isinstance(results["words"], list)
        assert isinstance(results["segments"], list)


class TestRepeatFinding:
    """Tests for RepeatFinding dataclass."""

    def test_finding_attributes(self):
        """Verify RepeatFinding has expected attributes."""
        finding = RepeatFinding(
            kind="words",
            length=1,
            repeats=3,
            start_index=0,
            snippet="...test...",
            sequence="Hello",
            char_start=0,
            char_end=15,
            segment_start=None,
            segment_end=None,
            start_time=None,
            end_time=None,
        )

        assert finding.kind == "words"
        assert finding.repeats == 3
        assert finding.sequence == "Hello"
        assert finding.boundary is False  # Default value
