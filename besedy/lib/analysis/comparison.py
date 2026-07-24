"""Cross-model transcript comparison."""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass

from besedy.lib.analysis.base import TimeSpanMixin


@dataclass
class ModelSegment(TimeSpanMixin):
    """A segment from a specific model."""

    start: float
    end: float
    text: str
    confidence: float | None


@dataclass
class IntervalComparison(TimeSpanMixin):
    """Comparison of models over a time interval."""

    start: float
    end: float
    texts: dict[str, str]  # model_key -> text
    confidences: dict[str, float | None]  # model_key -> confidence


@dataclass
class ComparisonResult:
    """Results of comparing transcripts for a single audio hash."""

    audio_hash: str
    models: list[str]
    coverage_seconds: dict[str, float]
    overlap_seconds_all: float
    agreements: int
    disagreements: int
    disagreement_samples: list[tuple[float, float, dict[str, str]]]


TEXT_NORMALIZER = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    """Normalize text for comparison."""
    lowered = text.lower().strip()
    return TEXT_NORMALIZER.sub(" ", lowered)


def collect_boundaries(transcripts: dict[str, list[ModelSegment]]) -> list[float]:
    """Collect all unique segment boundaries from all models."""
    boundaries = {0.0}
    for segments in transcripts.values():
        for seg in segments:
            boundaries.add(round(seg.start, 3))
            boundaries.add(round(seg.end, 3))

    # Remove NaN values
    boundaries = {b for b in boundaries if not math.isnan(b)}
    return sorted(boundaries)


def build_interval_comparisons(
    transcripts: dict[str, list[ModelSegment]],
) -> list[IntervalComparison]:
    """Build aligned intervals for comparison across models."""
    boundaries = collect_boundaries(transcripts)
    intervals: list[IntervalComparison] = []

    if len(boundaries) < 2:
        return intervals

    for idx in range(len(boundaries) - 1):
        start = boundaries[idx]
        end = boundaries[idx + 1]

        if end - start < 1e-3:
            continue

        texts: dict[str, str] = {}
        confidences: dict[str, float | None] = {}

        for model_key, segments in transcripts.items():
            overlapping_texts: list[str] = []
            confs: list[float] = []

            for seg in segments:
                if seg.end <= start or seg.start >= end:
                    continue

                if seg.text:
                    overlapping_texts.append(seg.text)
                if seg.confidence is not None:
                    confs.append(seg.confidence)

            if overlapping_texts:
                combined = " ".join(t.strip() for t in overlapping_texts if t.strip()).strip()
                if combined:
                    texts[model_key] = combined
                    confidences[model_key] = sum(confs) / len(confs) if confs else None

        if texts:
            intervals.append(
                IntervalComparison(
                    start=start,
                    end=end,
                    texts=texts,
                    confidences=confidences,
                )
            )

    return intervals


def compare_transcripts(
    transcripts: dict[str, list[ModelSegment]],
    audio_hash: str,
    sample_limit: int = 5,
) -> ComparisonResult:
    """Compare transcripts from multiple models.

    Args:
        transcripts: Dictionary of model_key -> list of segments
        audio_hash: Audio hash identifier
        sample_limit: Maximum number of disagreement samples to collect

    Returns:
        ComparisonResult with statistics and samples
    """
    intervals = build_interval_comparisons(transcripts)

    coverage_seconds: dict[str, float] = defaultdict(float)
    overlap_seconds_all = 0.0
    disagreement_samples: list[tuple[float, float, dict[str, str]]] = []
    disagreements = 0
    agreements = 0

    for interval in intervals:
        dur = interval.duration
        present_models = set(interval.texts.keys())

        # Update coverage
        for model_key in present_models:
            coverage_seconds[model_key] += dur

        # Update overlap (all models present)
        if len(present_models) == len(transcripts):
            overlap_seconds_all += dur

        # Check for disagreements
        if len(present_models) < 2:
            continue

        normalized = {mk: normalize_text(text) for mk, text in interval.texts.items() if text}
        unique_texts = {txt for txt in normalized.values() if txt}

        if len(unique_texts) <= 1:
            agreements += 1
        else:
            disagreements += 1
            if len(disagreement_samples) < sample_limit:
                disagreement_samples.append((interval.start, interval.end, interval.texts))

    return ComparisonResult(
        audio_hash=audio_hash,
        models=list(transcripts.keys()),
        coverage_seconds=dict(coverage_seconds),
        overlap_seconds_all=overlap_seconds_all,
        agreements=agreements,
        disagreements=disagreements,
        disagreement_samples=disagreement_samples,
    )


def format_time(seconds: float) -> str:
    """Format seconds as HH:MM:SS.ss or MM:SS.ss."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60

    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:05.2f}"
    return f"{minutes:02d}:{secs:05.2f}"
