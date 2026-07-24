"""Utilities for building transcript coverage reports."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

from besedy.lib.data.lookup import find_transcripts_for_hash, load_transcript_json

from .timeline import (
    build_time_intervals,
    collect_time_points,
    extract_segments,
    merge_all_consecutive,
    merge_short_intervals,
    sample_intervals,
    summarize_intervals,
)
from .timeline import (
    coverage_stats as compute_coverage_stats,
)


def _float_stat(stats: dict[str, Any], key: str) -> float:
    value = stats.get(key, 0.0)
    return float(value) if isinstance(value, (int, float)) else 0.0


def _int_stat(stats: dict[str, Any], key: str) -> int:
    value = stats.get(key, 0)
    return int(value) if isinstance(value, (int, float)) else 0


def load_segments_for_hash(
    hash_component: str, transcripts_root: Path
) -> tuple[dict[str, list[Any]], float]:
    matches = find_transcripts_for_hash(hash_component, transcripts_root)
    segments_by_source: dict[str, list[Any]] = {}
    durations: list[float] = []

    for source, path in sorted(matches.items()):
        data = load_transcript_json(path)
        if not data:
            continue
        segments = extract_segments(data, source)
        if not segments:
            continue
        segments_by_source[source] = segments
        duration = _duration_from_transcript(data)
        if duration:
            durations.append(duration)

    total_duration = max(durations) if durations else 0.0
    return segments_by_source, total_duration


def _duration_from_transcript(transcript: dict) -> float:
    meta = transcript.get("meta", {})
    duration = meta.get("duration") if isinstance(meta, dict) else None
    if isinstance(duration, (int, float)):
        return float(duration)
    segments = transcript.get("segments", []) or []
    if not segments:
        return 0.0
    try:
        return max(float(seg.get("end", 0.0)) for seg in segments)
    except (TypeError, ValueError):
        return 0.0


def generate_coverage_payload(
    hash_component: str,
    transcripts_root: Path,
    *,
    merge: str | None = None,
    min_duration: float = 0.5,
    sample_limit: int = 10,
) -> dict[str, object]:
    segments_by_source, total_duration = load_segments_for_hash(hash_component, transcripts_root)
    if not segments_by_source:
        raise FileNotFoundError(f"No transcripts found for hash {hash_component}")

    typed_segments_by_source = cast(dict[str, Any], segments_by_source)
    time_points = collect_time_points(typed_segments_by_source)
    intervals = build_time_intervals(time_points, typed_segments_by_source)
    before_count = len(intervals)

    if merge == "short":
        intervals = merge_short_intervals(intervals, min_duration=min_duration)
    elif merge == "all":
        intervals = merge_all_consecutive(intervals)

    stats = compute_coverage_stats(intervals, total_duration)
    summary = summarize_intervals(intervals)
    samples = sample_intervals(
        intervals,
        limit=sample_limit,
        preferred_sources=list(segments_by_source.keys()),
    )

    sources_meta = []
    for source, segments in segments_by_source.items():
        durations = [seg.duration for seg in segments]
        avg = (sum(durations) / len(durations)) if durations else 0.0
        sources_meta.append(
            {
                "source": source,
                "segments": len(segments),
                "avg_segment_duration": avg,
            }
        )

    return {
        "hash": hash_component,
        "sources": sources_meta,
        "interval_counts": {"before": before_count, "after": len(intervals)},
        "merge_strategy": merge or "none",
        "total_duration": total_duration,
        "stats": stats.as_dict(),
        "interval_summary": summary,
        "samples": samples,
    }


def render_text_report(payload: dict[str, object], *, include_samples: bool = True) -> str:
    parts: list[str] = []
    parts.append(f"Segment coverage for hash: {payload['hash']}")
    parts.append("")
    parts.append("Sources:")
    sources = payload.get("sources", [])
    if not isinstance(sources, list):
        sources = []
    for meta in sources:
        if not isinstance(meta, dict):
            continue
        meta = cast(dict[str, Any], meta)
        parts.append(
            f"  - {meta['source']}: {meta['segments']} segments (avg {meta['avg_segment_duration']:.2f}s)"
        )

    stats = payload.get("stats", {})
    if not isinstance(stats, dict):
        stats = {}
    stats = cast(dict[str, Any], stats)
    parts.append("")
    parts.append("Time coverage:")
    parts.append(
        f"  Triplets: {_float_stat(stats, 'triplet_duration'):.1f}s "
        f"({_float_stat(stats, 'triplet_percentage'):.1f}%)"
    )
    parts.append(
        f"  Doublets: {_float_stat(stats, 'doublet_duration'):.1f}s "
        f"({_float_stat(stats, 'doublet_percentage'):.1f}%)"
    )
    parts.append(
        f"  Singletons: {_float_stat(stats, 'singleton_duration'):.1f}s "
        f"({_float_stat(stats, 'singleton_percentage'):.1f}%)"
    )
    parts.append(
        f"  Covered: {_float_stat(stats, 'covered_duration'):.1f}s "
        f"({_float_stat(stats, 'coverage_percentage'):.1f}%)"
    )

    interval_counts = payload.get("interval_counts", {})
    if not isinstance(interval_counts, dict):
        interval_counts = {}
    interval_counts = cast(dict[str, Any], interval_counts)
    parts.append("")
    parts.append(
        f"Intervals: {_int_stat(interval_counts, 'after')} "
        f"(from {_int_stat(interval_counts, 'before')} before merge, strategy={payload['merge_strategy']})"
    )

    summary = payload.get("interval_summary", {})
    if not isinstance(summary, dict):
        summary = {}
    summary = cast(dict[str, Any], summary)
    percentiles = summary.get("percentiles", {})
    if not isinstance(percentiles, dict):
        percentiles = {}
    percentiles = cast(dict[str, Any], percentiles)
    parts.append(
        "  Duration median {median:.2f}s, mean {mean:.2f}s, p95 {p95:.2f}s".format(
            median=_float_stat(percentiles, "median"),
            mean=_float_stat(percentiles, "mean"),
            p95=_float_stat(percentiles, "p95"),
        )
    )

    samples = payload.get("samples", [])
    if not isinstance(samples, list):
        samples = []
    if include_samples and samples:
        parts.append("")
        parts.append("Sample intervals:")
        for sample in samples:
            if not isinstance(sample, dict):
                continue
            sample = cast(dict[str, Any], sample)
            parts.append(
                f"  - {sample['start']:.2f}s to {sample['end']:.2f}s ({sample['duration']:.2f}s, {len(sample['segments'])} sources)"
            )
    return "\n".join(parts)


__all__ = [
    "generate_coverage_payload",
    "render_text_report",
]
