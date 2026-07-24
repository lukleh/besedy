"""Canonical schema validation logic."""

from __future__ import annotations

from typing import Any, cast

from besedy.lib.backend_ids import TRANSCRIPT_META_BACKENDS

TRANSCRIPT_META_REQUIRED_FIELDS = (
    "model",
    "backend",
    "audio_filepath",
    "duration",
    "generation_params",
)


def validate_meta(meta: dict[str, Any]) -> list[str]:
    """Validate meta object and return list of issues."""
    issues = []

    for field in TRANSCRIPT_META_REQUIRED_FIELDS:
        if field not in meta:
            issues.append(f"meta.{field} is required but missing")

    if "backend" in meta and meta["backend"] not in TRANSCRIPT_META_BACKENDS:
        issues.append(f"meta.backend has unexpected value: {meta['backend']}")

    return issues


def validate_segment(seg: dict[str, Any], seg_idx: int, prev_end: float | None) -> list[str]:
    """Validate a single segment and return list of issues."""
    issues = []

    # Required fields
    required = ["start", "end", "text", "confidence", "words"]
    for field in required:
        if field not in seg:
            issues.append(f"segments[{seg_idx}].{field} is missing")
            return issues  # Can't continue without these

    start = seg["start"]
    end = seg["end"]
    confidence = seg["confidence"]

    # Type checks
    if not isinstance(start, (int, float)):
        issues.append(f"segments[{seg_idx}].start must be a number, got {type(start).__name__}")
    if not isinstance(end, (int, float)):
        issues.append(f"segments[{seg_idx}].end must be a number, got {type(end).__name__}")
    if not isinstance(seg["text"], str):
        issues.append(
            f"segments[{seg_idx}].text must be a string, got {type(seg['text']).__name__}"
        )
    if confidence is not None and not isinstance(confidence, (int, float)):
        issues.append(
            f"segments[{seg_idx}].confidence must be a number or null, got {type(confidence).__name__}"
        )

    # Value checks
    if isinstance(start, (int, float)) and isinstance(end, (int, float)):
        if end < start:
            issues.append(f"segments[{seg_idx}]: end ({end}) < start ({start})")

        # Monotonicity check
        if prev_end is not None and start < prev_end:
            issues.append(
                f"segments[{seg_idx}]: start ({start}) < previous segment end ({prev_end}) - not monotonic"
            )

    # Confidence range check
    if confidence is not None and isinstance(confidence, (int, float)):
        if confidence < 0 or confidence > 1:
            issues.append(f"segments[{seg_idx}].confidence ({confidence}) not in [0, 1]")

    # Words validation
    if not isinstance(seg["words"], list):
        issues.append(f"segments[{seg_idx}].words must be a list")
    else:
        issues.extend(validate_words(seg["words"], seg_idx, start, end))

    return issues


def validate_words(
    words: list[dict[str, Any]], seg_idx: int, seg_start: float, seg_end: float
) -> list[str]:
    """Validate word array for a segment."""
    issues = []
    prev_word_end = None

    for word_idx, word in enumerate(words):
        required = ["start", "end", "word", "confidence"]
        for field in required:
            if field not in word:
                issues.append(f"segments[{seg_idx}].words[{word_idx}].{field} is missing")
                continue

        if "start" not in word or "end" not in word:
            continue

        w_start = word["start"]
        w_end = word["end"]
        w_conf = word.get("confidence")

        # Type checks
        if not isinstance(w_start, (int, float)):
            issues.append(f"segments[{seg_idx}].words[{word_idx}].start must be a number")
        if not isinstance(w_end, (int, float)):
            issues.append(f"segments[{seg_idx}].words[{word_idx}].end must be a number")
        if not isinstance(word["word"], str):
            issues.append(f"segments[{seg_idx}].words[{word_idx}].word must be a string")

        if isinstance(w_start, (int, float)) and isinstance(w_end, (int, float)):
            # Word-level timing checks
            if w_end < w_start:
                issues.append(
                    f"segments[{seg_idx}].words[{word_idx}]: end ({w_end}) < start ({w_start})"
                )

            # Words should be within segment bounds (with small tolerance)
            tolerance = 0.001
            if w_start < seg_start - tolerance:
                issues.append(
                    f"segments[{seg_idx}].words[{word_idx}]: start ({w_start}) < segment start ({seg_start})"
                )
            if w_end > seg_end + tolerance:
                issues.append(
                    f"segments[{seg_idx}].words[{word_idx}]: end ({w_end}) > segment end ({seg_end})"
                )

            # Word-level monotonicity (words shouldn't overlap)
            if prev_word_end is not None and w_start < prev_word_end - tolerance:
                issues.append(
                    f"segments[{seg_idx}].words[{word_idx}]: start ({w_start}) < previous word end ({prev_word_end})"
                )

            prev_word_end = w_end

        # Confidence range
        if w_conf is not None and isinstance(w_conf, (int, float)):
            if w_conf < 0 or w_conf > 1:
                issues.append(
                    f"segments[{seg_idx}].words[{word_idx}].confidence ({w_conf}) not in [0, 1]"
                )

    return issues


def validate_canonical_schema(data: dict[str, Any]) -> list[str]:
    """Validate entire transcript against canonical schema."""
    issues = []

    # Top-level structure
    if "meta" not in data:
        issues.append("Top-level 'meta' object is required")
    else:
        issues.extend(validate_meta(data["meta"]))

    if "segments" not in data:
        issues.append("Top-level 'segments' array is required")
        return issues

    if not isinstance(data["segments"], list):
        issues.append("'segments' must be an array")
        return issues

    # Validate each segment
    prev_end = None
    for idx, seg in enumerate(data["segments"]):
        if not isinstance(seg, dict):
            issues.append(f"segments[{idx}] must be an object")
            continue
        seg = cast(dict[str, Any], seg)

        seg_issues = validate_segment(seg, idx, prev_end)
        issues.extend(seg_issues)

        if "end" in seg and isinstance(seg["end"], (int, float)):
            prev_end = seg["end"]

    return issues
