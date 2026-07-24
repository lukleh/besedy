#!/usr/bin/env python3
"""Convert WhisperX transcript JSON into the canonical Besedy schema."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from besedy.lib.audio.probe import measure_audio_duration_seconds
from besedy.lib.data import whisperx_conversion as _conversion
from besedy.lib.data.atomic_io import atomic_write_text

# Historical imports from this CLI module remain valid while reusable code uses
# besedy.lib.data.whisperx_conversion directly.
WhisperXConversionError = _conversion.WhisperXConversionError
_build_segments = _conversion._build_segments
_ensure_list = _conversion._ensure_list
_ensure_number = _conversion._ensure_number
convert_whisperx = _conversion.convert_whisperx

DEFAULT_MODEL = "large-v3"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert WhisperX transcript JSON to canonical schema."
    )
    parser.add_argument("input", type=Path, help="Path to WhisperX JSON output.")
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
        default="whisperx",
        help="Backend label to store in meta (default: whisperx).",
    )
    parser.add_argument(
        "--align-model",
        default=None,
        help="Alignment model identifier used in WhisperX.",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help="Model identifier to store in meta.",
    )
    parser.add_argument(
        "--vad-method",
        default=None,
        help="VAD method identifier to store in meta.",
    )
    parser.add_argument(
        "--compute-type",
        default=None,
        help="Compute type identifier to store in meta.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=None,
        help="Batch size to store in meta.",
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

    converted = convert_whisperx(
        payload,
        backend=args.backend,
        model=args.model,
        duration_seconds=duration_seconds,
        audio_filepath=stored_audio_path,
        align_model=args.align_model,
        vad_method=args.vad_method,
        compute_type=args.compute_type,
        batch_size=args.batch_size,
    )

    serialized = json.dumps(converted, ensure_ascii=False, indent=args.indent)
    atomic_write_text(output_path, serialized, encoding="utf-8")
    print(f"Converted: {input_path} -> {output_path}")


if __name__ == "__main__":
    raise SystemExit(main())
