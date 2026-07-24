"""Edge case detection for transcript validation."""

from __future__ import annotations

from typing import Any


def find_empty_segments(data: dict[str, Any]) -> list[int]:
    """Find segments with empty or whitespace-only text."""
    empty = []
    for idx, seg in enumerate(data.get("segments", [])):
        text = seg.get("text", "")
        if not text or not text.strip():
            empty.append(idx)
    return empty


def find_zero_duration_segments(data: dict[str, Any]) -> list[int]:
    """Find segments where start == end."""
    zero_dur = []
    for idx, seg in enumerate(data.get("segments", [])):
        if seg.get("start") == seg.get("end"):
            zero_dur.append(idx)
    return zero_dur


def find_segments_with_zero_duration_words(
    data: dict[str, Any],
) -> list[tuple[int, str, list[tuple[int, str, float]]]]:
    """Find segments containing words where start == end."""
    issues = []
    for seg_idx, seg in enumerate(data.get("segments", [])):
        zero_words = []
        for word_idx, word in enumerate(seg.get("words", [])):
            if word.get("start") == word.get("end"):
                zero_words.append((word_idx, word.get("word", ""), word.get("start")))

        if zero_words:
            issues.append((seg_idx, seg.get("text", "")[:80], zero_words))

    return issues


def find_overlapping_words(data: dict[str, Any]) -> list[tuple[int, int, str, float, str, float]]:
    """Find segments where words overlap in time."""
    overlaps = []
    for seg_idx, seg in enumerate(data.get("segments", [])):
        words = seg.get("words", [])
        for i in range(len(words) - 1):
            if words[i].get("end", 0) > words[i + 1].get("start", 0):
                overlaps.append(
                    (
                        seg_idx,
                        i,
                        words[i].get("word", ""),
                        words[i].get("end"),
                        words[i + 1].get("word", ""),
                        words[i + 1].get("start"),
                    )
                )

    return overlaps


def find_words_outside_segment_bounds(data: dict[str, Any]) -> list[tuple[int, int, str, str, str]]:
    """Find words with timing outside their segment bounds."""
    issues = []
    tolerance = 0.001  # 1ms tolerance for floating point

    for seg_idx, seg in enumerate(data.get("segments", [])):
        seg_start = seg.get("start", 0)
        seg_end = seg.get("end", 0)

        for word_idx, word in enumerate(seg.get("words", [])):
            w_start = word.get("start", 0)
            w_end = word.get("end", 0)

            if w_start < seg_start - tolerance or w_end > seg_end + tolerance:
                issues.append(
                    (
                        seg_idx,
                        word_idx,
                        word.get("word", ""),
                        f"word:{w_start:.3f}-{w_end:.3f}",
                        f"seg:{seg_start:.3f}-{seg_end:.3f}",
                    )
                )

    return issues
