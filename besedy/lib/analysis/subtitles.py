"""Subtitle rendering helpers for transcript segments."""

from __future__ import annotations

from collections.abc import Sequence

from besedy.lib.analysis.timeline import Segment


def _format_timestamp(seconds: float, separator: str) -> str:
    """Format seconds into HH:MM:SS{sep}mmm."""
    if seconds < 0:
        seconds = 0.0
    whole_seconds = int(seconds)
    millis = int(round((seconds - whole_seconds) * 1000))
    if millis >= 1000:
        whole_seconds += 1
        millis -= 1000
    hours, remainder = divmod(whole_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{millis:03d}"


def render_srt(segments: Sequence[Segment]) -> str:
    """Render segments into SRT format."""
    lines: list[str] = []
    index = 1
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        start = max(0.0, float(seg.start))
        end = max(0.0, float(seg.end))
        if end <= start:
            continue
        lines.append(str(index))
        lines.append(f"{_format_timestamp(start, ',')} --> {_format_timestamp(end, ',')}")
        lines.append(text)
        lines.append("")
        index += 1
    if not lines:
        return ""
    return "\n".join(lines).rstrip() + "\n"


def render_vtt(segments: Sequence[Segment]) -> str:
    """Render segments into WebVTT format."""
    lines: list[str] = ["WEBVTT", ""]
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        start = max(0.0, float(seg.start))
        end = max(0.0, float(seg.end))
        if end <= start:
            continue
        lines.append(f"{_format_timestamp(start, '.')} --> {_format_timestamp(end, '.')}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
