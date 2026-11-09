"""One transcript validator with explicit import and canonical field policies."""

from __future__ import annotations

import math
from typing import Any, TypeGuard, cast

from besedy.lib.backend_ids import TRANSCRIPT_META_BACKENDS

TRANSCRIPT_META_REQUIRED_FIELDS = (
    "model",
    "backend",
    "audio_filepath",
    "duration",
    "generation_params",
)
TIMING_TOLERANCE = 0.001


def is_finite_number(value: Any) -> TypeGuard[int | float]:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _validate_item(
    item: Any,
    *,
    label: str,
    text_field: str,
    canonical: bool,
    previous_end: float | None,
    bounds: tuple[float, float] | None = None,
) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label} must be an object"]
    issues: list[str] = []
    required = ("start", "end", text_field)
    if canonical:
        required += ("confidence",)
        if text_field == "text":
            required += ("words",)
    for field in required:
        if field not in item:
            issues.append(f"{label} missing '{field}'")
    for field in ("start", "end"):
        if field in item and not is_finite_number(item[field]):
            issues.append(f"{label} '{field}' must be a finite number")
    if text_field in item and not isinstance(item[text_field], str):
        issues.append(f"{label} '{text_field}' must be a string")
    confidence = item.get("confidence")
    if confidence is not None:
        if not is_finite_number(confidence):
            issues.append(f"{label} 'confidence' must be a finite number or null")
        elif not 0 <= confidence <= 1:
            issues.append(f"{label} 'confidence' must be in [0, 1]")
    start, end = item.get("start"), item.get("end")
    if is_finite_number(start) and is_finite_number(end):
        if start < 0:
            issues.append(f"{label} start ({start}) must be non-negative")
        if end < start:
            issues.append(f"{label} end ({end}) < start ({start})")
        tolerance = TIMING_TOLERANCE if bounds is not None else 0.0
        if previous_end is not None and start < previous_end - tolerance:
            issues.append(
                f"{label} start ({start}) < previous end ({previous_end}) - not monotonic"
            )
        if bounds is not None and (start < bounds[0] - tolerance or end > bounds[1] + tolerance):
            issues.append(f"{label} timing is outside segment bounds {bounds}")
    return issues


def validate_transcript_schema(data: Any, *, canonical: bool = False) -> list[str]:
    """Check shared types, confidence and timing invariants without raising.

    Import/CLI validation permits omitted metadata, words and confidence and
    requires nonempty segments. Canonical validation requires those fields and
    canonical backend metadata, but accepts an empty transcript (silent audio).
    Unknown confidence is null in both policies.
    """
    if not isinstance(data, dict):
        return ["Top-level JSON must be an object"]
    issues: list[str] = []
    if "meta" in data:
        meta = data["meta"]
        if not isinstance(meta, dict):
            issues.append("'meta' must be an object")
        elif canonical:
            for field in TRANSCRIPT_META_REQUIRED_FIELDS:
                if field not in meta:
                    issues.append(f"meta.{field} is required but missing")
            if "backend" in meta and (
                not isinstance(meta["backend"], str)
                or meta["backend"] not in TRANSCRIPT_META_BACKENDS
            ):
                issues.append(f"meta.backend has unexpected value: {meta['backend']}")
    elif canonical:
        issues.append("Top-level 'meta' object is required")
    segments = data.get("segments")
    if not isinstance(segments, list) or (not canonical and not segments):
        return issues + ["Missing or empty 'segments' list"]
    previous_end = None
    for index, segment in enumerate(segments):
        label = f"Segment {index}"
        issues.extend(
            _validate_item(
                segment,
                label=label,
                text_field="text",
                canonical=canonical,
                previous_end=previous_end,
            )
        )
        if not isinstance(segment, dict):
            continue
        segment = cast(dict[str, Any], segment)
        start, end = segment.get("start"), segment.get("end")
        bounds = (start, end) if is_finite_number(start) and is_finite_number(end) else None
        if is_finite_number(end):
            previous_end = end
        if "words" not in segment:
            continue
        words = segment["words"]
        if not isinstance(words, list):
            issues.append(f"{label} 'words' must be a list")
            continue
        previous_word_end = None
        for word_index, word in enumerate(words):
            issues.extend(
                _validate_item(
                    word,
                    label=f"{label} word {word_index}",
                    text_field="word",
                    canonical=canonical,
                    previous_end=previous_word_end,
                    bounds=bounds,
                )
            )
            if isinstance(word, dict) and is_finite_number(word.get("end")):
                previous_word_end = cast(dict[str, Any], word)["end"]
    return issues


def validate_canonical_schema(data: Any) -> list[str]:
    """Validate a complete canonical transcript, including required metadata."""
    return validate_transcript_schema(data, canonical=True)
