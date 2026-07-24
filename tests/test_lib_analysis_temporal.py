"""Unit tests for lib/analysis/temporal_fit module."""

from __future__ import annotations

from besedy.lib.analysis.temporal_fit import _interval_overlap, _merge_intervals


class TestMergeIntervals:
    """Tests for _merge_intervals function."""

    def test_merge_overlapping(self):
        intervals = [(0.0, 1.0), (0.5, 1.5), (3.0, 4.0)]
        merged = _merge_intervals(intervals)
        assert merged == [(0.0, 1.5), (3.0, 4.0)]

    def test_merge_adjacent(self):
        intervals = [(0.0, 1.0), (1.0, 2.0), (2.0, 3.0)]
        merged = _merge_intervals(intervals)
        assert merged == [(0.0, 3.0)]

    def test_merge_empty(self):
        assert _merge_intervals([]) == []

    def test_merge_single(self):
        intervals = [(1.0, 2.0)]
        merged = _merge_intervals(intervals)
        assert merged == [(1.0, 2.0)]

    def test_merge_non_overlapping(self):
        intervals = [(0.0, 1.0), (2.0, 3.0), (4.0, 5.0)]
        merged = _merge_intervals(intervals)
        assert merged == [(0.0, 1.0), (2.0, 3.0), (4.0, 5.0)]

    def test_merge_unsorted_input(self):
        intervals = [(3.0, 4.0), (0.0, 1.0), (0.5, 1.5)]
        merged = _merge_intervals(intervals)
        assert merged == [(0.0, 1.5), (3.0, 4.0)]


class TestIntervalOverlap:
    """Tests for _interval_overlap function."""

    def test_full_overlap(self):
        merged = [(0.0, 10.0)]
        overlap = _interval_overlap(2.0, 5.0, merged)
        assert overlap == 3.0

    def test_partial_overlap(self):
        merged = [(0.0, 3.0)]
        overlap = _interval_overlap(2.0, 5.0, merged)
        assert overlap == 1.0

    def test_no_overlap(self):
        merged = [(5.0, 10.0)]
        overlap = _interval_overlap(0.0, 3.0, merged)
        assert overlap == 0.0

    def test_multiple_intervals(self):
        merged = [(0.0, 2.0), (4.0, 6.0)]
        overlap = _interval_overlap(1.0, 5.0, merged)
        assert overlap == 2.0  # 1.0 from first + 1.0 from second

    def test_empty_intervals(self):
        overlap = _interval_overlap(0.0, 5.0, [])
        assert overlap == 0.0
