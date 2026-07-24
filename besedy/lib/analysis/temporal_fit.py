"""Temporal interval operations for transcript analysis.

Provides functions for working with time intervals in transcripts:
- _merge_intervals: Merge overlapping time intervals
- _interval_overlap: Compute overlap between segment and intervals
"""

from __future__ import annotations

from collections.abc import Iterable


def _merge_intervals(
    intervals: Iterable[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Merge overlapping [start, end] tuples into a sorted union.

    Args:
        intervals: Iterable of (start, end) tuples representing time intervals

    Returns:
        List of merged, non-overlapping intervals sorted by start time.
        Intervals within 1e-6 seconds are considered touching.
    """
    cleaned = [(float(s), float(e)) for s, e in intervals if e > s]
    if not cleaned:
        return []

    cleaned.sort(key=lambda item: item[0])
    merged: list[tuple[float, float]] = []
    cur_start, cur_end = cleaned[0]
    for start, end in cleaned[1:]:
        if start <= cur_end + 1e-6:
            cur_end = max(cur_end, end)
        else:
            merged.append((cur_start, cur_end))
            cur_start, cur_end = start, end
    merged.append((cur_start, cur_end))
    return merged


def _interval_overlap(
    segment_start: float,
    segment_end: float,
    merged_intervals: list[tuple[float, float]],
) -> float:
    """Return overlap length between a segment and merged coverage intervals.

    Args:
        segment_start: Start time of the segment
        segment_end: End time of the segment
        merged_intervals: List of non-overlapping intervals (from _merge_intervals)

    Returns:
        Total overlap time in seconds between segment and intervals
    """
    covered = 0.0
    for start, end in merged_intervals:
        if end <= segment_start:
            continue
        if start >= segment_end:
            break
        overlap = min(end, segment_end) - max(start, segment_start)
        if overlap > 0:
            covered += overlap
    return covered


__all__ = ["_merge_intervals", "_interval_overlap"]
