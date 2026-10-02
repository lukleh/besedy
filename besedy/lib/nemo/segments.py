"""Segment splitting and text processing for NeMo transcription.

This module handles:
- Segment chunking to enforce max_segment_length
- Finding optimal split points in silence regions
- Text normalization and control token removal
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

import numpy as np

from besedy.config.settings import config

#: Regex pattern matching Canary control tokens like <|startofcontext|>
CONTROL_TOKEN_PATTERN = re.compile(r"<\|[^>]+?\|>")


# ---------------------------------------------------------------------------
# ChunkingParams
# ---------------------------------------------------------------------------


@dataclass
class ChunkingParams:
    """Parameters controlling how long segments are split into chunks.

    Attributes:
        max_segment_length: Maximum duration (seconds) before splitting.
        min_silence_duration: Minimum silence duration (seconds) required
            to consider a region as a valid split point.
        silence_threshold: VAD probability below which frames are considered silence.
        precision: Decimal places for rounding timestamps.
    """

    max_segment_length: float = 30.0
    min_silence_duration: float = field(default_factory=lambda: config.nemo.min_silence_duration)
    silence_threshold: float = 0.35
    precision: int = field(default_factory=lambda: config.nemo.precision)


# ---------------------------------------------------------------------------
# Parameter helpers
# ---------------------------------------------------------------------------


def build_chunking_params(
    *,
    chunk_length: float | None,
    chunk_min_silence_ms: int | None,
    chunk_silence_threshold: float | None,
    default_silence_threshold: float,
) -> ChunkingParams | None:
    """Build chunking parameters from CLI-style overrides.

    Returns ``None`` when chunking is disabled. Otherwise, only explicit
    overrides are passed through so ``ChunkingParams`` can supply its own
    defaults, including the canonical 30-second max segment length.
    """

    if (
        chunk_length is None
        and chunk_min_silence_ms is None
        and chunk_silence_threshold is None
    ):
        return None

    silence_threshold = (
        float(chunk_silence_threshold)
        if chunk_silence_threshold is not None
        else float(default_silence_threshold)
    )
    max_segment_length = float(chunk_length) if chunk_length is not None else None
    min_silence_duration = (
        max(float(chunk_min_silence_ms) / 1000.0, 0.01)
        if chunk_min_silence_ms is not None
        else None
    )

    if max_segment_length is None and min_silence_duration is None:
        return ChunkingParams(silence_threshold=silence_threshold)
    if max_segment_length is None:
        assert min_silence_duration is not None
        return ChunkingParams(
            min_silence_duration=min_silence_duration,
            silence_threshold=silence_threshold,
        )
    if min_silence_duration is None:
        assert max_segment_length is not None
        return ChunkingParams(
            max_segment_length=max_segment_length,
            silence_threshold=silence_threshold,
        )
    return ChunkingParams(
        max_segment_length=max_segment_length,
        min_silence_duration=min_silence_duration,
        silence_threshold=silence_threshold,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _segment_mean_prob(
    frame_probs: np.ndarray | None,
    frame_unit: float,
    start: float,
    end: float,
) -> float:
    """Compute mean VAD probability for a time range.

    Args:
        frame_probs: Array of per-frame VAD probabilities.
        frame_unit: Duration (seconds) of each frame.
        start: Start time (seconds).
        end: End time (seconds).

    Returns:
        Mean probability in [0, 1], or 0.0 if inputs are invalid.
    """
    if frame_probs is None or frame_probs.size == 0 or frame_unit <= 0.0:
        return 0.0

    total_frames = frame_probs.shape[0]
    start_idx = max(0, int(np.floor(start / frame_unit)))

    # RTTM boundaries can round slightly past the last frame; clamp to avoid OOB.
    if start_idx >= total_frames:
        return float(frame_probs[-1])

    end_idx = max(start_idx + 1, int(np.ceil(end / frame_unit)))
    end_idx = min(end_idx, total_frames)

    if end_idx <= start_idx:
        return float(frame_probs[start_idx])

    return float(frame_probs[start_idx:end_idx].mean())


def _find_split_time(
    frame_probs: np.ndarray | None,
    frame_unit: float,
    start_time: float,
    limit_time: float,
    params: ChunkingParams,
) -> float:
    """Find optimal split point within a time range based on silence detection.

    Scans frame probabilities to find the end of a silence region that meets
    the minimum duration requirement. Returns the split time at the end of
    the last qualifying silence region, or limit_time if none found.

    Args:
        frame_probs: Array of per-frame VAD probabilities.
        frame_unit: Duration (seconds) of each frame.
        start_time: Start of search range (seconds).
        limit_time: End of search range (seconds).
        params: Chunking parameters including silence_threshold and min_silence_duration.

    Returns:
        Optimal split time (seconds), rounded to params.precision.
    """
    if frame_probs is None or frame_probs.size == 0 or frame_unit <= 0.0:
        return round(limit_time, params.precision)

    start_idx = max(0, int(np.floor(start_time / frame_unit)))
    limit_idx = min(frame_probs.shape[0], int(np.ceil(limit_time / frame_unit)))
    if limit_idx <= start_idx:
        return round(limit_time, params.precision)

    min_block = max(1, int(np.ceil(params.min_silence_duration / frame_unit)))
    candidate_idx = None
    run_start = None
    silence_threshold = params.silence_threshold

    for idx in range(start_idx, limit_idx):
        prob = frame_probs[idx]
        if prob < silence_threshold:
            if run_start is None:
                run_start = idx
        else:
            if run_start is not None and idx - run_start >= min_block:
                candidate_idx = idx
            run_start = None

    if run_start is not None and limit_idx - run_start >= min_block:
        candidate_idx = limit_idx

    if candidate_idx is not None:
        split_time = candidate_idx * frame_unit
        if split_time <= start_time:
            return round(limit_time, params.precision)
        return round(split_time, params.precision)

    return round(limit_time, params.precision)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def split_segments_like_faster_whisper(
    segments: Sequence[dict],
    frame_probs: np.ndarray | None,
    frame_unit: float,
    params: ChunkingParams,
) -> list[dict]:
    """Split segments exceeding max_segment_length at silence boundaries.

    Mimics faster-whisper's approach: iteratively split long segments at
    detected silence regions. Each output segment includes mean_prob computed
    from the corresponding VAD frame probabilities.

    Args:
        segments: Input segments with 'start' and 'end' keys.
        frame_probs: Per-frame VAD probabilities (optional).
        frame_unit: Duration (seconds) of each frame.
        params: Chunking parameters.

    Returns:
        List of segments, each no longer than params.max_segment_length.
    """
    adjusted: list[dict] = []
    if not segments:
        return adjusted

    for segment in segments:
        start = float(segment.get("start", 0.0) or 0.0)
        end = float(segment.get("end", start) or start)
        if end <= start:
            continue

        current_start = start
        while True:
            remaining = end - current_start
            if remaining <= params.max_segment_length + 1e-6:
                current_end = end
            else:
                limit = current_start + params.max_segment_length
                current_end = _find_split_time(
                    frame_probs, frame_unit, current_start, min(limit, end), params
                )
                if current_end <= current_start:
                    current_end = min(limit, end)
            current_end = round(current_end, params.precision)
            current_start = round(current_start, params.precision)
            mean_prob = _segment_mean_prob(frame_probs, frame_unit, current_start, current_end)
            new_entry = dict(segment)
            new_entry.update(
                {"start": current_start, "end": current_end, "mean_prob": round(mean_prob, 4)}
            )
            adjusted.append(new_entry)

            if current_end >= end - 1e-6:
                break
            current_start = current_end

    return adjusted


def ensure_max_segment_length(
    chunk_segments: Iterable[dict],
    frame_probs: np.ndarray | None,
    frame_unit: float,
    params: ChunkingParams,
) -> list[dict]:
    """Ensure all segments respect max_segment_length by splitting as needed.

    Convenience wrapper around split_segments_like_faster_whisper.

    Args:
        chunk_segments: Input segments (will be converted to list).
        frame_probs: Per-frame VAD probabilities.
        frame_unit: Duration (seconds) of each frame.
        params: Chunking parameters.

    Returns:
        List of segments respecting max_segment_length.
    """
    return split_segments_like_faster_whisper(list(chunk_segments), frame_probs, frame_unit, params)


# ---------------------------------------------------------------------------
# Text processing
# ---------------------------------------------------------------------------


def strip_control_tokens(text: str) -> str:
    """Remove Canary control tokens (e.g., <|startofcontext|>) from decoded text.

    Args:
        text: Input text potentially containing control tokens.

    Returns:
        Cleaned text with control tokens removed and whitespace normalized.
    """
    if not text:
        return ""
    cleaned = CONTROL_TOKEN_PATTERN.sub(" ", text)
    return re.sub(r"\s+", " ", cleaned).strip()


def normalize_for_comparison(value: str | None) -> str:
    """Normalize text for comparison by lowercasing and collapsing whitespace.

    Args:
        value: Input string or None.

    Returns:
        Normalized lowercase string, or empty string if input is None/empty.
    """
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip().lower()
