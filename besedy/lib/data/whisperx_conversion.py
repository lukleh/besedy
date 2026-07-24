"""Convert WhisperX payloads into the canonical Besedy transcript schema."""

from __future__ import annotations

import math
from typing import Any


class WhisperXConversionError(RuntimeError):
    """Raised when WhisperX data cannot be converted reliably."""


def _ensure_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise WhisperXConversionError(f"{label} must be a list")
    return value


def _ensure_number(value: Any, label: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        raise WhisperXConversionError(f"{label} must be a number")


def _build_segments(payload: dict) -> tuple[list[dict[str, Any]], str, int]:
    segments_raw = _ensure_list(payload.get("segments"), "segments")

    segments_payload: list[dict[str, Any]] = []
    transcript_parts: list[str] = []
    total_words = 0
    previous_end: float | None = None

    for seg_idx, seg in enumerate(segments_raw):
        if not isinstance(seg, dict):
            raise WhisperXConversionError(f"segment[{seg_idx}] must be a dict")

        start = _ensure_number(seg.get("start", 0.0), f"segment[{seg_idx}].start")
        end = _ensure_number(seg.get("end", start), f"segment[{seg_idx}].end")

        if previous_end is not None and start < previous_end:
            start = previous_end
            if end < start:
                end = start

        text = (seg.get("text") or "").strip()
        transcript_parts.append(text)

        words_payload: list[dict[str, Any]] = []
        word_confidences: list[float] = []
        words_raw = seg.get("words") or []
        if not isinstance(words_raw, list):
            raise WhisperXConversionError(f"segment[{seg_idx}].words must be a list")

        for word_idx, word in enumerate(words_raw):
            if not isinstance(word, dict):
                raise WhisperXConversionError(
                    f"segment[{seg_idx}].words[{word_idx}] must be a dict"
                )

            word_text = (word.get("word") or "").strip()
            if not word_text:
                continue

            w_start = word.get("start")
            w_end = word.get("end")
            if w_start is None and w_end is None:
                w_start = w_end = start
            if w_start is None:
                w_start = w_end
            if w_end is None:
                w_end = w_start

            w_start = float(w_start) if w_start is not None else start
            w_end = float(w_end) if w_end is not None else w_start
            if w_end < w_start:
                w_end = w_start

            w_start = max(start, w_start)
            w_end = min(end, max(w_end, w_start))
            if words_payload:
                prev_end = words_payload[-1]["end"]
                if w_start < prev_end:
                    w_start = prev_end
                    w_end = max(w_end, w_start)

            score = word.get("score")
            confidence = float(score) if score is not None else None
            if confidence is not None:
                confidence = max(0.0, min(1.0, confidence))
                word_confidences.append(confidence)

            words_payload.append(
                {
                    "start": round(w_start, 6),
                    "end": round(w_end, 6),
                    "word": word_text,
                    "confidence": confidence,
                }
            )

        total_words += len(words_payload)

        segment_confidence: float | None = None
        if word_confidences:
            segment_confidence = sum(word_confidences) / len(word_confidences)
        else:
            avg_logprob = seg.get("avg_logprob")
            if avg_logprob is not None:
                try:
                    segment_confidence = float(math.exp(float(avg_logprob)))
                except (TypeError, ValueError, OverflowError):
                    segment_confidence = None

        segments_payload.append(
            {
                "start": round(start, 6),
                "end": round(end, 6),
                "text": text,
                "confidence": segment_confidence,
                "words": words_payload,
            }
        )
        previous_end = segments_payload[-1]["end"]

    transcript_text = " ".join(part for part in transcript_parts if part).strip()
    return segments_payload, transcript_text, total_words


def convert_whisperx(
    payload: dict,
    *,
    backend: str,
    model: str,
    duration_seconds: float,
    audio_filepath: str | None,
    align_model: str | None = None,
    vad_method: str | None = None,
    compute_type: str | None = None,
    batch_size: int | None = None,
) -> dict:
    """Convert one WhisperX response into a canonical transcript payload."""

    segments_payload, transcript_text, total_words = _build_segments(payload)

    generation_params: dict[str, Any] = {"language": payload.get("language")}
    if align_model:
        generation_params["align_model"] = align_model
    if vad_method:
        generation_params["vad_method"] = vad_method
    if compute_type:
        generation_params["compute_type"] = compute_type
    if batch_size is not None:
        generation_params["batch_size"] = batch_size

    meta = {
        "backend": backend,
        "model": model,
        "audio_filepath": audio_filepath,
        "duration": duration_seconds,
        "num_segments": len(segments_payload),
        "num_words": total_words,
        "transcript_text": transcript_text,
        "generation_params": generation_params,
    }

    return {"meta": meta, "segments": segments_payload}


__all__ = ["WhisperXConversionError", "convert_whisperx"]
