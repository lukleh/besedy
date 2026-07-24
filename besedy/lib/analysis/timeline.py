"""Time-interval utilities shared by coverage/merge analyzers."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import cast

from besedy.lib.analysis.base import TimeSpanMixin


@dataclass(frozen=True)
class Segment(TimeSpanMixin):
    """Transcript segment with timing metadata."""

    start: float
    end: float
    text: str
    source: str
    index: int


@dataclass
class TimeInterval(TimeSpanMixin):
    """Continuous time window with the segments that cover it."""

    start: float
    end: float
    segments: dict[str, list[Segment]]

    @property
    def coverage(self) -> int:
        return len(self.segments)


@dataclass
class CoverageStats:
    total_duration: float
    covered_duration: float
    uncovered_duration: float
    triplet_duration: float
    doublet_duration: float
    singleton_duration: float
    triplet_count: int
    doublet_count: int
    singleton_count: int

    def as_dict(self) -> dict[str, float | int]:
        def percentage(value: float) -> float:
            return (value / self.total_duration * 100) if self.total_duration else 0.0

        return {
            "total_duration": self.total_duration,
            "covered_duration": self.covered_duration,
            "uncovered_duration": self.uncovered_duration,
            "triplet_duration": self.triplet_duration,
            "doublet_duration": self.doublet_duration,
            "singleton_duration": self.singleton_duration,
            "triplet_count": self.triplet_count,
            "doublet_count": self.doublet_count,
            "singleton_count": self.singleton_count,
            "triplet_percentage": percentage(self.triplet_duration),
            "doublet_percentage": percentage(self.doublet_duration),
            "singleton_percentage": percentage(self.singleton_duration),
            "coverage_percentage": percentage(self.covered_duration),
        }


def extract_segments(transcript: dict, source: str) -> list[Segment]:
    """Convert transcript JSON into Segment objects."""

    segments: list[Segment] = []
    for idx, seg in enumerate(transcript.get("segments", []) or []):
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        try:
            start = float(seg.get("start", 0.0))
            end = float(seg.get("end", 0.0))
        except (TypeError, ValueError):
            continue
        segments.append(Segment(start=start, end=end, text=text, source=source, index=idx))
    return segments


def collect_time_points(segments_by_source: dict[str, Sequence[Segment]]) -> list[float]:
    """Return sorted unique boundaries from all segment start/end times."""

    points = set()
    for segments in segments_by_source.values():
        for seg in segments:
            points.add(seg.start)
            points.add(seg.end)
    return sorted(points)


def build_time_intervals(
    time_points: Sequence[float],
    segments_by_source: dict[str, Sequence[Segment]],
    *,
    min_duration: float = 1e-3,
) -> list[TimeInterval]:
    """Create ordered TimeInterval objects spanning all time boundaries.

    This function implements a sweep-line algorithm to partition a timeline into
    intervals where each interval has a consistent set of covering segments from
    each source (backend/model).

    Algorithm:
        1. Iterate consecutive pairs of time points to define interval boundaries
        2. For each interval [start, end], find segments from each source that
           fully cover this interval (segment.start <= start AND segment.end >= end)
        3. Create TimeInterval with the covering segments from all sources
        4. Skip intervals shorter than min_duration to filter noise

    Complexity:
        Time: O(n * m) where n = len(time_points), m = total segments across sources
        Space: O(n) for output intervals

    Args:
        time_points: Sorted sequence of all segment boundary times.
        segments_by_source: Dict mapping source name to list of Segment objects.
        min_duration: Minimum interval duration in seconds. Defaults to 1e-3 (1ms)
            to filter out floating-point boundary artifacts.

    Returns:
        List of TimeInterval objects, sorted by start time. Each interval
        contains a dict of which sources have segments covering that time span.

    Note:
        - The 1e-6 tolerance in coverage checks handles floating-point precision
        - Intervals with no covering segments from ANY source are excluded
        - Use collect_time_points() to generate the time_points input
    """
    intervals: list[TimeInterval] = []
    for idx in range(len(time_points) - 1):
        start = time_points[idx]
        end = time_points[idx + 1]
        if end - start < min_duration:
            continue

        covering: dict[str, list[Segment]] = {}
        for source, segments in segments_by_source.items():
            active = [
                seg for seg in segments if seg.start <= start + 1e-6 and seg.end >= end - 1e-6
            ]
            if active:
                covering[source] = active

        if covering:
            intervals.append(TimeInterval(start=start, end=end, segments=covering))
    return intervals


def coverage_stats(intervals: Sequence[TimeInterval], total_duration: float) -> CoverageStats:
    """Compute coverage metrics for the provided intervals."""

    triplet_dur = sum(iv.duration for iv in intervals if iv.coverage == 3)
    doublet_dur = sum(iv.duration for iv in intervals if iv.coverage == 2)
    singleton_dur = sum(iv.duration for iv in intervals if iv.coverage == 1)
    covered = triplet_dur + doublet_dur + singleton_dur

    return CoverageStats(
        total_duration=total_duration,
        covered_duration=covered,
        uncovered_duration=max(0.0, total_duration - covered),
        triplet_duration=triplet_dur,
        doublet_duration=doublet_dur,
        singleton_duration=singleton_dur,
        triplet_count=sum(1 for iv in intervals if iv.coverage == 3),
        doublet_count=sum(1 for iv in intervals if iv.coverage == 2),
        singleton_count=sum(1 for iv in intervals if iv.coverage == 1),
    )


def merge_short_intervals(
    intervals: Sequence[TimeInterval], *, min_duration: float
) -> list[TimeInterval]:
    """Merge adjacent intervals that share the same sources when a span is short."""

    if not intervals:
        return []

    merged: list[TimeInterval] = []
    current = intervals[0]
    for candidate in intervals[1:]:
        same_sources = set(current.segments.keys()) == set(candidate.segments.keys())
        short = current.duration < min_duration or candidate.duration < min_duration
        consecutive = abs(current.end - candidate.start) < 1e-2

        if same_sources and short and consecutive:
            current = TimeInterval(
                start=current.start,
                end=candidate.end,
                segments=current.segments,
            )
        else:
            merged.append(current)
            current = candidate
    merged.append(current)
    return merged


def merge_all_consecutive(intervals: Sequence[TimeInterval]) -> list[TimeInterval]:
    """Merge any consecutive intervals that share identical source coverage."""

    if not intervals:
        return []

    merged: list[TimeInterval] = []
    current = intervals[0]
    for candidate in intervals[1:]:
        same_sources = set(current.segments.keys()) == set(candidate.segments.keys())
        consecutive = abs(current.end - candidate.start) < 1e-2
        if same_sources and consecutive:
            current = TimeInterval(
                start=current.start,
                end=candidate.end,
                segments=current.segments,
            )
        else:
            merged.append(current)
            current = candidate
    merged.append(current)
    return merged


def interval_length_buckets(intervals: Sequence[TimeInterval]) -> dict[str, int]:
    """Return histogram buckets useful for console summaries."""

    buckets = {
        "<0.5s": 0,
        "0.5-1s": 0,
        "1-2s": 0,
        "2-3s": 0,
        "3-5s": 0,
        "5-10s": 0,
        "10-20s": 0,
        ">=20s": 0,
    }
    for dur in (iv.duration for iv in intervals):
        if dur < 0.5:
            buckets["<0.5s"] += 1
        elif dur < 1.0:
            buckets["0.5-1s"] += 1
        elif dur < 2.0:
            buckets["1-2s"] += 1
        elif dur < 3.0:
            buckets["2-3s"] += 1
        elif dur < 5.0:
            buckets["3-5s"] += 1
        elif dur < 10.0:
            buckets["5-10s"] += 1
        elif dur < 20.0:
            buckets["10-20s"] += 1
        else:
            buckets[">=20s"] += 1
    return buckets


def interval_percentiles(intervals: Sequence[TimeInterval]) -> dict[str, float]:
    """Compute rough percentile stats for interval durations."""

    durations = sorted(iv.duration for iv in intervals if iv.duration > 0)
    if not durations:
        return {}

    def percentile(p: float) -> float:
        if not durations:
            return 0.0
        if len(durations) == 1:
            return durations[0]
        rank = (p / 100) * (len(durations) - 1)
        lower = int(rank)
        upper = min(len(durations) - 1, lower + 1)
        weight = rank - lower
        return durations[lower] + (durations[upper] - durations[lower]) * weight

    return {
        "min": durations[0],
        "max": durations[-1],
        "median": percentile(50),
        "mean": sum(durations) / len(durations),
        "p25": percentile(25),
        "p75": percentile(75),
        "p90": percentile(90),
        "p95": percentile(95),
        "p99": percentile(99),
    }


def summarize_intervals(
    intervals: Sequence[TimeInterval],
) -> dict[str, dict[str, float] | dict[str, int] | int]:
    """Return combined summary info covering percentiles and histograms."""

    return {
        "count": len(intervals),
        "percentiles": interval_percentiles(intervals),
        "histogram": interval_length_buckets(intervals),
        "triplet_count": sum(1 for iv in intervals if iv.coverage == 3),
        "doublet_count": sum(1 for iv in intervals if iv.coverage == 2),
        "singleton_count": sum(1 for iv in intervals if iv.coverage == 1),
    }


def sample_intervals(
    intervals: Sequence[TimeInterval],
    *,
    limit: int = 10,
    preferred_sources: Sequence[str] | None = None,
) -> list[dict[str, object]]:
    """Return representative samples (default: triplets)."""

    preferred_sources = list(preferred_sources or [])
    triplets = [iv for iv in intervals if iv.coverage >= 3]
    samples = triplets[:limit] if triplets else list(intervals[:limit])

    formatted: list[dict[str, object]] = []
    for iv in samples:
        entry: dict[str, object] = {
            "start": iv.start,
            "end": iv.end,
            "duration": iv.duration,
            "segments": {},
        }
        ordered_sources = preferred_sources + [
            s for s in iv.segments.keys() if s not in preferred_sources
        ]
        for source in ordered_sources:
            segs = iv.segments.get(source)
            if not segs:
                continue
            seg = segs[0]
            segments_payload = cast(dict[str, object], entry["segments"])
            segments_payload[source] = {
                "text": seg.text,
                "index": seg.index,
                "start": seg.start,
                "end": seg.end,
            }
        formatted.append(entry)
    return formatted


__all__ = [
    "Segment",
    "TimeInterval",
    "CoverageStats",
    "extract_segments",
    "collect_time_points",
    "build_time_intervals",
    "coverage_stats",
    "merge_short_intervals",
    "merge_all_consecutive",
    "summarize_intervals",
    "sample_intervals",
]
