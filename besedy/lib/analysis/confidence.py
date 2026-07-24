"""Confidence analytics shared across CLI tools."""

from __future__ import annotations

import statistics
from typing import Any

from .repetition import RepeatFinding, find_word_repeats


def extract_confidences_for_span(
    finding: RepeatFinding,
    segments: list[dict[str, Any]],
) -> list[float]:
    """Sample word confidence values across a repeated span."""

    confidences: list[float] = []
    char_positions = range(
        finding.char_start,
        finding.char_end,
        max(1, (finding.char_end - finding.char_start) // 25 or 1),
    )
    for char_pos in char_positions:
        placement = locate_word_by_char_position(segments, char_pos)
        if placement is None:
            continue
        word = placement[0]
        conf = word.get("confidence")
        if conf is None:
            continue
        try:
            confidences.append(float(conf))
        except (TypeError, ValueError):
            continue
    return confidences


def locate_word_by_char_position(
    segments: list[dict[str, Any]],
    char_pos: int,
) -> tuple[dict[str, Any], int, int] | None:
    """Return (word_dict, segment_index, word_index) covering char_pos."""

    current = 0
    for seg_idx, segment in enumerate(segments):
        text = segment.get("text", "") or ""
        seg_start = current
        seg_end = current + len(text)
        if seg_start <= char_pos < seg_end:
            words = segment.get("words", []) or []
            for word_idx, word in enumerate(words):
                word_text = word.get("word") or word.get("text") or ""
                pos = text.find(word_text)
                if pos < 0:
                    continue
                word_char_start = seg_start + pos
                word_char_end = word_char_start + len(word_text)
                if word_char_start <= char_pos < word_char_end:
                    return (word, seg_idx, word_idx)
            if words:
                return (words[0], seg_idx, 0)
        current = seg_end + 1
    return None


def analyze_repetition_confidence(
    data: dict[str, Any],
    *,
    min_word_repeats: int = 2,
    max_word_len: int = 8,
) -> dict[str, Any]:
    """Return baseline vs. repetition confidence metrics."""

    segments = data.get("segments", []) or []
    if not segments:
        return {"error": "no segments"}

    full_text = "\n".join(seg.get("text", "") for seg in segments)
    word_repeats = find_word_repeats(
        full_text,
        min_len=1,
        max_len=max_word_len,
        min_repeats=min_word_repeats,
    )

    repetitions: list[dict[str, Any]] = []
    for finding in word_repeats:
        confidences = extract_confidences_for_span(finding, segments)
        if not confidences:
            continue
        repetitions.append(
            {
                "sequence": finding.sequence,
                "length": finding.length,
                "repeats": finding.repeats,
                "total_span": finding.length * finding.repeats,
                "char_start": finding.char_start,
                "char_end": finding.char_end,
                "snippet": finding.snippet,
                "confidences": confidences,
                "confidence_mean": statistics.mean(confidences),
                "confidence_median": statistics.median(confidences),
                "confidence_min": min(confidences),
                "confidence_max": max(confidences),
                "confidence_stdev": statistics.stdev(confidences) if len(confidences) > 1 else 0.0,
            }
        )

    all_confidences = [
        float(word.get("confidence"))
        for seg in segments
        for word in seg.get("words", []) or []
        if isinstance(word.get("confidence"), (int, float))
    ]
    repetitions_flat = [conf for entry in repetitions for conf in entry["confidences"]]

    baseline_stats = summarize_confidences(all_confidences)
    repetition_stats = summarize_confidences(repetitions_flat)

    return {
        "baseline": baseline_stats,
        "repetitions": repetition_stats,
        "difference": {
            "mean_diff": (baseline_stats["mean"] or 0) - (repetition_stats["mean"] or 0),
            "median_diff": (baseline_stats["median"] or 0) - (repetition_stats["median"] or 0),
        },
        "total_words": len(all_confidences),
        "total_repetitions": len(word_repeats),
        "repetition_details": repetitions,
    }


def summarize_confidences(values: list[float]) -> dict[str, float]:
    if not values:
        return {"mean": 0.0, "median": 0.0, "min": 0.0, "max": 0.0, "stdev": 0.0}
    return {
        "mean": statistics.mean(values),
        "median": statistics.median(values),
        "min": min(values),
        "max": max(values),
        "stdev": statistics.stdev(values) if len(values) > 1 else 0.0,
    }


__all__ = [
    "analyze_repetition_confidence",
    "extract_confidences_for_span",
]
