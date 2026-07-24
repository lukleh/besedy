"""Backend-specific verification for transcripts."""

from __future__ import annotations

import re
from typing import Any

# ==============================================================================
# Legacy whisper.cpp Verification
# ==============================================================================


def normalize_text(text: str) -> str:
    """Normalize text for comparison (collapse whitespace, strip)."""
    return re.sub(r"\s+", " ", text.strip())


def check_text_preservation(original: dict[str, Any], converted: dict[str, Any]) -> list[str]:
    """Verify that segment texts are preserved."""
    issues = []

    orig_segments = original.get("transcription", [])
    conv_segments = converted.get("segments", [])

    if len(orig_segments) != len(conv_segments):
        issues.append(
            f"Segment count mismatch: original={len(orig_segments)} vs converted={len(conv_segments)}"
        )
        return issues

    for idx, (orig_seg, conv_seg) in enumerate(zip(orig_segments, conv_segments)):
        orig_text = normalize_text(orig_seg.get("text", ""))
        conv_text = normalize_text(conv_seg.get("text", ""))

        if orig_text != conv_text:
            issues.append(
                f"Segment {idx} text mismatch:\n  original: {orig_text[:100]}\n  converted: {conv_text[:100]}"
            )

    return issues


def check_timing_conversion(original: dict[str, Any], converted: dict[str, Any]) -> list[str]:
    """Verify that millisecond offsets are correctly converted to seconds."""
    issues = []

    orig_segments = original.get("transcription", [])
    conv_segments = converted.get("segments", [])

    for idx, (orig_seg, conv_seg) in enumerate(zip(orig_segments, conv_segments)):
        offsets = orig_seg.get("offsets", {})
        orig_start_ms = offsets.get("from")
        orig_end_ms = offsets.get("to")

        if orig_start_ms is None or orig_end_ms is None:
            continue

        expected_start = orig_start_ms / 1000.0
        expected_end = orig_end_ms / 1000.0

        conv_start = conv_seg["start"]
        conv_end = conv_seg["end"]

        # Allow tiny floating point differences
        if abs(conv_start - expected_start) > 0.001:
            issues.append(
                f"Segment {idx}: start time mismatch\n"
                f"  expected: {expected_start:.3f}s ({orig_start_ms}ms)\n"
                f"  got: {conv_start:.3f}s"
            )

        if abs(conv_end - expected_end) > 0.001:
            issues.append(
                f"Segment {idx}: end time mismatch\n"
                f"  expected: {expected_end:.3f}s ({orig_end_ms}ms)\n"
                f"  got: {conv_end:.3f}s"
            )

    return issues


def verify_whisper_cpp_conversion(
    original: dict[str, Any], converted: dict[str, Any]
) -> tuple[bool, list[str]]:
    """Verify legacy whisper.cpp conversion preserves text and timing.

    Returns:
        (success, issues)
    """
    all_issues = []

    # Text preservation
    all_issues.extend(check_text_preservation(original, converted))

    # Timing conversion
    all_issues.extend(check_timing_conversion(original, converted))

    success = len(all_issues) == 0
    return success, all_issues
