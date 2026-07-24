#!/usr/bin/env python3
"""Convert stable-ts transcript JSON into the canonical Besedy schema."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

from besedy.lib.audio.probe import measure_audio_duration_seconds
from besedy.lib.data.atomic_io import atomic_write_text
from besedy.lib.workflow.config import get_transcription_workflows


class StableTsConversionError(RuntimeError):
    """Raised when stable-ts data cannot be converted reliably."""


def _ensure_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise StableTsConversionError(f"{label} must be a list")
    return value


def _ensure_number(value: Any, label: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        raise StableTsConversionError(f"{label} must be a number")


def _build_segments(payload: dict) -> tuple[list[dict[str, Any]], str, int]:
    segments_raw = _ensure_list(payload.get("segments"), "segments")

    segments_payload: list[dict[str, Any]] = []
    transcript_parts: list[str] = []
    total_words = 0
    previous_end: float | None = None

    for seg_idx, seg in enumerate(segments_raw):
        if not isinstance(seg, dict):
            raise StableTsConversionError(f"segment[{seg_idx}] must be a dict")

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
            raise StableTsConversionError(f"segment[{seg_idx}].words must be a list")

        for word_idx, word in enumerate(words_raw):
            if not isinstance(word, dict):
                raise StableTsConversionError(
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

            probability = word.get("probability")
            confidence = float(probability) if probability is not None else None
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


def convert_stable_ts(
    payload: dict,
    *,
    backend: str,
    model: str,
    duration_seconds: float,
    audio_filepath: str | None,
    stable_backend: str | None = None,
) -> dict:
    segments_payload, transcript_text, total_words = _build_segments(payload)

    generation_params: dict[str, Any] = {
        "language": payload.get("language"),
    }
    if stable_backend:
        generation_params["stable_ts_backend"] = stable_backend

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert stable-ts transcript JSON to canonical schema."
    )
    parser.add_argument("input", type=Path, help="Path to stable-ts JSON output.")
    parser.add_argument(
        "--audio",
        type=Path,
        help="Path to staged audio WAV (used to derive duration and stored in meta).",
    )
    parser.add_argument(
        "--duration",
        type=float,
        help="Duration in seconds (used if --audio is not provided).",
    )
    parser.add_argument(
        "--audio-path",
        type=Path,
        help="Audio path to store in meta if different from --audio.",
    )
    parser.add_argument(
        "--backend",
        default="stable-ts",
        help="Backend label to store in meta (default: stable-ts).",
    )
    parser.add_argument(
        "--stable-backend",
        default=None,
        help="Underlying stable-ts backend label (e.g., faster-whisper, huggingface).",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Model identifier to store in meta.",
    )
    parser.add_argument("--output", type=Path, help="Output transcript.json path.")
    parser.add_argument("--indent", type=int, default=2, help="Indentation level.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_path = args.input.expanduser().resolve()
    if not input_path.is_file():
        raise SystemExit(f"Input file not found: {input_path}")

    with input_path.open(encoding="utf-8") as handle:
        payload = json.load(handle)

    audio_path: Path | None = None
    if args.audio is not None:
        audio_path = args.audio.expanduser().resolve()
        if not audio_path.is_file():
            raise SystemExit(f"Audio file not found: {audio_path}")

    if args.duration is None and audio_path is None:
        raise SystemExit("Provide --audio or --duration to populate metadata.")

    if args.duration is not None:
        duration_seconds = float(args.duration)
    else:
        assert audio_path is not None
        duration_seconds = measure_audio_duration_seconds(audio_path)

    stored_audio_path: str | None = None
    if args.audio_path is not None:
        stored_audio_path = str(args.audio_path.expanduser().resolve())
    elif audio_path is not None:
        stored_audio_path = str(audio_path)

    output_path = (
        args.output.expanduser().resolve()
        if args.output
        else input_path.with_name("transcript.json")
    )

    if args.model is None:
        configs = get_transcription_workflows(workflow_id="faster-whisper")
        if not configs:
            raise SystemExit("No faster-whisper workflow configured in besedy.toml.")
        args.model = configs[0].model_name

    converted = convert_stable_ts(
        payload,
        backend=args.backend,
        model=args.model,
        duration_seconds=duration_seconds,
        audio_filepath=stored_audio_path,
        stable_backend=args.stable_backend,
    )

    serialized = json.dumps(converted, ensure_ascii=False, indent=args.indent)
    atomic_write_text(output_path, serialized, encoding="utf-8")
    print(f"Converted: {input_path} -> {output_path}")


if __name__ == "__main__":
    raise SystemExit(main())
