"""Statistical analysis for transcripts."""

from __future__ import annotations


def extract_transcript_text(data: dict) -> str:
    """Extract full transcript text from various formats."""
    # Try meta.transcript_text first
    meta = data.get("meta")
    if isinstance(meta, dict):
        text = meta.get("transcript_text")
        if text:
            return str(text).strip()

    # Try pred_text
    text = data.get("pred_text")
    if text:
        return str(text).strip()

    # Try concatenating segments
    segments = data.get("segments", []) or []
    segment_texts: list[str] = []
    for seg in segments:
        segment_text = seg.get("text")
        if isinstance(segment_text, str):
            segment_texts.append(segment_text.strip())

    return " ".join(part for part in segment_texts if part).strip()
