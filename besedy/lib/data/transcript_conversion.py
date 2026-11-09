"""Shared timing and confidence normalization for clamping transcript writers."""

from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any, cast


class TranscriptConversionError(RuntimeError):
    """Backend data cannot be converted into a transcript reliably."""


def _number(value: Any, label: str, error_type: type[TranscriptConversionError]) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise error_type(f"{label} must be a finite number") from exc
    if isinstance(value, bool) or not math.isfinite(number):
        raise error_type(f"{label} must be a finite number")
    return number


def normalize_interval(
    start: float, end: float, *, lower: float, upper: float | None = None
) -> tuple[float, float]:
    """Clamp an interval and keep its end at or after its start.

    A word entirely outside its segment becomes a zero-length interval at the
    nearest boundary. Text is retained even when alignment supplied no usable
    duration. ``lower`` also carries the previous interval's end.
    """
    start = max(lower, start)
    if upper is not None:
        start = min(upper, start)
    end = max(start, end)
    if upper is not None:
        end = min(upper, end)
    return round(start, 6), round(end, 6)


def normalize_segments(
    raw_segments: Iterable[Any],
    *,
    confidence_field: str,
    error_type: type[TranscriptConversionError] = TranscriptConversionError,
) -> tuple[list[dict[str, Any]], str, int]:
    """Normalize common segment/word fields; adapters choose their score field."""
    segments: list[dict[str, Any]] = []
    previous_end = 0.0
    for index, raw in enumerate(raw_segments):
        label = f"segment[{index}]"
        if not isinstance(raw, dict):
            raise error_type(f"{label} must be a dict")
        raw = cast(dict[str, Any], raw)
        raw_start = _number(raw.get("start", 0.0), f"{label}.start", error_type)
        raw_end = _number(raw.get("end", raw_start), f"{label}.end", error_type)
        start, end = normalize_interval(raw_start, raw_end, lower=previous_end)
        text = raw.get("text") or ""
        if not isinstance(text, str):
            raise error_type(f"{label}.text must be a string")
        raw_words = raw.get("words")
        if raw_words is None:
            raw_words = []
        if not isinstance(raw_words, list):
            raise error_type(f"{label}.words must be a list")
        words: list[dict[str, Any]] = []
        scores: list[float] = []
        word_end = start
        for word_index, raw_word in enumerate(raw_words):
            word_label = f"{label}.words[{word_index}]"
            if not isinstance(raw_word, dict):
                raise error_type(f"{word_label} must be a dict")
            word_text = raw_word.get("word") or ""
            if not isinstance(word_text, str):
                raise error_type(f"{word_label}.word must be a string")
            if not word_text.strip():
                continue
            w_start = raw_word.get("start")
            w_end = raw_word.get("end")
            if w_start is None:
                w_start = w_end if w_end is not None else start
            if w_end is None:
                w_end = w_start
            w_start, w_end = normalize_interval(
                _number(w_start, f"{word_label}.start", error_type),
                _number(w_end, f"{word_label}.end", error_type),
                lower=word_end,
                upper=end,
            )
            score = raw_word.get(confidence_field)
            confidence = (
                max(0.0, min(1.0, _number(score, f"{word_label}.{confidence_field}", error_type)))
                if score is not None
                else None
            )
            if confidence is not None:
                scores.append(confidence)
            words.append(
                {
                    "start": w_start,
                    "end": w_end,
                    "word": word_text.strip(),
                    "confidence": confidence,
                }
            )
            word_end = w_end
        confidence = None
        if scores:
            confidence = sum(scores) / len(scores)
        elif raw.get("avg_logprob") is not None:
            # Missing or unusable segment scores remain unknown, as before.
            try:
                probability = math.exp(float(raw["avg_logprob"]))
                if math.isfinite(probability):
                    confidence = max(0.0, min(1.0, probability))
            except (TypeError, ValueError, OverflowError):
                pass
        segments.append(
            {
                "start": start,
                "end": end,
                "text": text.strip(),
                "confidence": confidence,
                "words": words,
            }
        )
        previous_end = end
    return (
        segments,
        " ".join(segment["text"] for segment in segments if segment["text"]),
        sum(len(segment["words"]) for segment in segments),
    )


def convert_transcript(
    payload: dict,
    *,
    backend: str,
    model: str,
    duration_seconds: float,
    audio_filepath: str | None,
    generation_params: dict[str, Any],
    confidence_field: str,
    error_type: type[TranscriptConversionError],
) -> dict:
    raw_segments = payload.get("segments")
    if not isinstance(raw_segments, list):
        raise error_type("segments must be a list")
    segments, text, word_count = normalize_segments(
        raw_segments, confidence_field=confidence_field, error_type=error_type
    )
    return {
        "meta": {
            "backend": backend,
            "model": model,
            "audio_filepath": audio_filepath,
            "duration": duration_seconds,
            "num_segments": len(segments),
            "num_words": word_count,
            "transcript_text": text,
            "generation_params": generation_params,
        },
        "segments": segments,
    }
