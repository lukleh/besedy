#!/usr/bin/env python3
"""Convert stable-ts transcript JSON into the canonical Besedy schema."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from besedy.lib.audio.probe import measure_audio_duration_seconds
from besedy.lib.data.atomic_io import atomic_write_text
from besedy.lib.data.transcript_conversion import TranscriptConversionError, convert_transcript
from besedy.lib.workflow.config import get_transcription_workflows


class StableTsConversionError(TranscriptConversionError):
    """Raised when stable-ts data cannot be converted reliably."""


def convert_stable_ts(
    payload: dict,
    *,
    backend: str,
    model: str,
    duration_seconds: float,
    audio_filepath: str | None,
    stable_backend: str | None = None,
) -> dict:
    if not isinstance(payload, dict):
        raise StableTsConversionError("transcript must be an object")

    generation_params: dict[str, Any] = {
        "language": payload.get("language"),
    }
    if stable_backend:
        generation_params["stable_ts_backend"] = stable_backend

    return convert_transcript(
        payload,
        backend=backend,
        model=model,
        duration_seconds=duration_seconds,
        audio_filepath=audio_filepath,
        generation_params=generation_params,
        confidence_field="probability",
        error_type=StableTsConversionError,
    )


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
