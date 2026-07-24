"""Unit tests for lib/analysis/subtitles module."""

from __future__ import annotations

from besedy.lib.analysis.subtitles import render_srt, render_vtt
from besedy.lib.analysis.timeline import Segment


def _make_segment(start: float, end: float, text: str) -> Segment:
    """Helper to create a Segment with default source and index."""
    return Segment(start=start, end=end, text=text, source="test", index=0)


class TestRenderSrt:
    """Tests for SRT format rendering."""

    def test_single_segment(self):
        segments = [_make_segment(0.0, 1.5, "Hello world")]
        result = render_srt(segments)
        expected = "1\n00:00:00,000 --> 00:00:01,500\nHello world\n"
        assert result == expected

    def test_multiple_segments(self):
        segments = [
            _make_segment(0.0, 1.0, "First line"),
            _make_segment(2.0, 3.5, "Second line"),
        ]
        result = render_srt(segments)
        lines = result.strip().split("\n")
        assert lines[0] == "1"
        assert lines[1] == "00:00:00,000 --> 00:00:01,000"
        assert lines[2] == "First line"
        assert lines[4] == "2"
        assert lines[5] == "00:00:02,000 --> 00:00:03,500"
        assert lines[6] == "Second line"

    def test_empty_segments(self):
        segments: list[Segment] = []
        result = render_srt(segments)
        assert result == ""

    def test_skips_empty_text(self):
        segments = [
            _make_segment(0.0, 1.0, "Valid"),
            _make_segment(1.0, 2.0, ""),
            _make_segment(2.0, 3.0, "   "),
            _make_segment(3.0, 4.0, "Also valid"),
        ]
        result = render_srt(segments)
        assert "1\n" in result
        assert "2\n" in result
        assert "3\n" not in result  # Only 2 valid segments

    def test_skips_zero_duration(self):
        segments = [
            _make_segment(1.0, 1.0, "Zero duration"),
            _make_segment(2.0, 3.0, "Valid"),
        ]
        result = render_srt(segments)
        assert "Zero duration" not in result
        assert "Valid" in result

    def test_skips_negative_duration(self):
        segments = [
            _make_segment(2.0, 1.0, "Negative duration"),
            _make_segment(3.0, 4.0, "Valid"),
        ]
        result = render_srt(segments)
        assert "Negative duration" not in result
        assert "Valid" in result

    def test_clamps_negative_timestamps(self):
        segments = [_make_segment(-1.0, 1.0, "Negative start")]
        result = render_srt(segments)
        assert "00:00:00,000 --> 00:00:01,000" in result

    def test_hour_timestamps(self):
        segments = [_make_segment(3661.5, 3662.0, "Over an hour")]
        result = render_srt(segments)
        assert "01:01:01,500 --> 01:01:02,000" in result

    def test_millisecond_rounding(self):
        # 999.9999 ms should round to 1000ms = 1s, not 999ms
        segments = [_make_segment(0.0, 0.9999, "Rounding test")]
        result = render_srt(segments)
        # Should be clamped/rounded properly
        assert "00:00:00,000 --> 00:00:01,000" in result

    def test_strips_whitespace_from_text(self):
        segments = [_make_segment(0.0, 1.0, "  padded text  ")]
        result = render_srt(segments)
        assert "padded text\n" in result
        assert "  padded text  " not in result

    def test_uses_comma_separator(self):
        """SRT uses comma as millisecond separator."""
        segments = [_make_segment(0.0, 1.5, "Test")]
        result = render_srt(segments)
        assert "00:00:00,000" in result
        assert "00:00:00.000" not in result


class TestRenderVtt:
    """Tests for WebVTT format rendering."""

    def test_starts_with_webvtt_header(self):
        segments = [_make_segment(0.0, 1.0, "Test")]
        result = render_vtt(segments)
        assert result.startswith("WEBVTT\n")

    def test_single_segment(self):
        segments = [_make_segment(0.0, 1.5, "Hello world")]
        result = render_vtt(segments)
        assert "00:00:00.000 --> 00:00:01.500" in result
        assert "Hello world" in result

    def test_empty_segments(self):
        segments: list[Segment] = []
        result = render_vtt(segments)
        assert result == "WEBVTT\n"

    def test_skips_empty_text(self):
        segments = [
            _make_segment(0.0, 1.0, "Valid"),
            _make_segment(1.0, 2.0, ""),
            _make_segment(2.0, 3.0, "Also valid"),
        ]
        result = render_vtt(segments)
        lines = result.strip().split("\n")
        text_lines = [line for line in lines if line and "-->" not in line and line != "WEBVTT"]
        assert text_lines == ["Valid", "Also valid"]

    def test_skips_zero_duration(self):
        segments = [
            _make_segment(1.0, 1.0, "Zero duration"),
            _make_segment(2.0, 3.0, "Valid"),
        ]
        result = render_vtt(segments)
        assert "Zero duration" not in result
        assert "Valid" in result

    def test_uses_dot_separator(self):
        """VTT uses dot as millisecond separator."""
        segments = [_make_segment(0.0, 1.5, "Test")]
        result = render_vtt(segments)
        assert "00:00:00.000" in result
        assert "00:00:00,000" not in result

    def test_no_sequence_numbers(self):
        """VTT doesn't require sequence numbers (unlike SRT)."""
        segments = [
            _make_segment(0.0, 1.0, "First"),
            _make_segment(1.0, 2.0, "Second"),
        ]
        result = render_vtt(segments)
        lines = result.strip().split("\n")
        # No lines should be just "1" or "2"
        assert "1" not in lines
        assert "2" not in lines

    def test_hour_timestamps(self):
        segments = [_make_segment(3661.5, 3662.0, "Over an hour")]
        result = render_vtt(segments)
        assert "01:01:01.500 --> 01:01:02.000" in result


class TestTimestampFormatting:
    """Tests for timestamp edge cases shared between formats."""

    def test_exact_minute_boundary(self):
        segments = [_make_segment(60.0, 61.0, "One minute")]
        srt = render_srt(segments)
        vtt = render_vtt(segments)
        assert "00:01:00" in srt
        assert "00:01:00" in vtt

    def test_exact_hour_boundary(self):
        segments = [_make_segment(3600.0, 3601.0, "One hour")]
        srt = render_srt(segments)
        vtt = render_vtt(segments)
        assert "01:00:00" in srt
        assert "01:00:00" in vtt

    def test_large_hour_value(self):
        # 100 hours = 360000 seconds
        segments = [_make_segment(360000.0, 360001.0, "100 hours")]
        srt = render_srt(segments)
        vtt = render_vtt(segments)
        assert "100:00:00" in srt
        assert "100:00:00" in vtt
