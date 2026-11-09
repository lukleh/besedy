#!/usr/bin/env python3
"""Minimal faster-whisper CLI that writes per-hash transcript artifacts."""

from __future__ import annotations

import argparse
import json
import logging
from dataclasses import asdict, is_dataclass, replace
from pathlib import Path
from typing import Any

from faster_whisper import BatchedInferencePipeline, WhisperModel
from tqdm.auto import tqdm

from besedy.config.settings import config
from besedy.core.paths import (
    FASTER_WHISPER_VAD_MODEL_FILENAME,
    require_valid_hash_stem,
    resolve_project_path,
    resolve_transcripts_root,
)
from besedy.lib.audio.probe import measure_audio_duration_seconds
from besedy.lib.data.atomic_io import atomic_write_text
from besedy.lib.data.transcript_conversion import normalize_segments
from besedy.lib.workflow.config import select_transcription_workflow
from besedy.lib.workflow.faster_whisper_options import production_transcribe_options
from besedy.lib.workflow.language import (
    resolve_inference_language,
    resolve_language_setting,
)
from besedy.lib.workflow.paths import sanitize_model_identifier


class TqdmLoggingHandler(logging.Handler):
    """Route logging records through tqdm.write to avoid clobbering the progress bar."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            tqdm.write(msg)
        except Exception:  # pragma: no cover - defensive fallback
            self.handleError(record)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Transcribe staged audio with faster-whisper and persist JSON payloads.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--audio",
        type=Path,
        nargs="+",
        required=True,
        help="One or more staged WAV paths (filename stem should be the SHA256 hash).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Root directory for transcripts; defaults to <repo>/transcripts/faster-whisper.",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="faster-whisper model alias to load (e.g., large-v3).",
    )
    parser.add_argument(
        "--vad-model",
        default=None,
        help="VAD model identifier used in output path metadata (e.g., silero_vad_v6).",
    )
    parser.add_argument(
        "--device",
        default="cuda",
        help="Inference device passed to faster-whisper (cuda, cpu, auto).",
    )
    parser.add_argument(
        "--compute-type",
        default="float16",
        help="Compute type passed to faster-whisper (float16, int8, etc.).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=8,
        help="Batch size for BatchedInferencePipeline.transcribe.",
    )
    parser.add_argument(
        "--language",
        default=None,
        help=(
            "Language code forwarded to faster-whisper. Use 'auto' for language detection; "
            "defaults to the configured workflow language."
        ),
    )
    return parser.parse_args()


def resolve_bundle_root(
    output_dir: Path | None,
    model_name: str,
    vad_model: str | None = None,
    *,
    language: str,
) -> Path:
    base_config = select_transcription_workflow("faster-whisper")
    workflow_config = replace(
        base_config,
        model_name=model_name,
        vad_model=vad_model,
        align_model=None,
        language=language,
    )
    component = workflow_config.output_component(sanitize_model_identifier)

    if output_dir is not None:
        workflow_root = resolve_project_path(output_dir)
    else:
        workflow_root = resolve_transcripts_root(None) / base_config.workflow_label

    target_root = workflow_root / component
    target_root.mkdir(parents=True, exist_ok=True)
    return target_root


def ensure_audio_files(paths: list[Path]) -> list[Path]:
    resolved: list[Path] = []
    for audio_path in paths:
        candidate = audio_path.expanduser().resolve()
        if not candidate.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")
        resolved.append(candidate)
    return resolved


def resolve_model_reference(model_name: str) -> str:
    """Resolve local model paths while preserving Hugging Face model identifiers."""
    candidate = Path(model_name).expanduser()

    # Treat explicit filesystem paths as local and fail early when missing.
    if candidate.is_absolute() or model_name.startswith(("~", "./", "../", ".\\", "..\\")):
        resolved = candidate.resolve()
        if not resolved.exists():
            raise FileNotFoundError(
                "Local faster-whisper model path not found: "
                f"{resolved}. Update --model / besedy.toml or use a Hugging Face model ID "
                "(e.g. 'large-v3')."
            )
        return str(resolved)

    # Existing relative paths are valid local model directories.
    if candidate.exists():
        return str(candidate.resolve())

    # Non-path strings are interpreted by faster-whisper as model IDs.
    return model_name


def build_payload(
    audio_path: Path,
    *,
    model_name: str,
    device: str,
    compute_type: str,
    language: str | None,
    batch_size: int,
    vad_filter: bool,
    min_silence_ms: int | None,
    word_timestamps: bool,
    vad_model: str | None = None,
    info,
    segments,
) -> dict:
    segments_payload, transcript_text, total_words = normalize_segments(
        (
            {
                "start": getattr(seg, "start", 0.0) or 0.0,
                "end": getattr(seg, "end", None)
                if getattr(seg, "end", None) is not None
                else getattr(seg, "start", 0.0) or 0.0,
                "text": getattr(seg, "text", ""),
                "avg_logprob": getattr(seg, "avg_logprob", None),
                "words": [
                    {
                        key: getattr(word, key, None)
                        for key in ("start", "end", "word", "probability")
                    }
                    for word in getattr(seg, "words", []) or []
                ],
            }
            for seg in segments
        ),
        confidence_field="probability",
    )

    info_dict: dict[str, Any] = {}
    if info is not None:
        for key in ("language", "language_probability", "duration", "duration_after_vad"):
            value = getattr(info, key, None)
            if value is not None:
                info_dict[key] = value
        transcription_options = getattr(info, "transcription_options", None)
        if transcription_options is not None:
            if is_dataclass(transcription_options):
                info_dict["transcription_options"] = asdict(transcription_options)
            elif isinstance(transcription_options, dict):
                info_dict["transcription_options"] = dict(transcription_options)

    generation_params: dict[str, Any] = {
        "device": device,
        "compute_type": compute_type,
        "language": language,
        "batch_size": batch_size,
        "vad_filter": vad_filter,
        "min_silence_duration_ms": min_silence_ms,
        "word_timestamps": word_timestamps,
        "vad_model": vad_model or FASTER_WHISPER_VAD_MODEL_FILENAME,
    }
    generation_params.update(info_dict)
    generation_params = {k: v for k, v in generation_params.items() if v is not None}

    duration_val = measure_audio_duration_seconds(audio_path)

    meta: dict[str, Any] = {
        "backend": "faster-whisper",
        "model": model_name,
        "audio_filepath": str(audio_path),
        "duration": round(duration_val, 3) if duration_val is not None else None,
        "num_segments": len(segments_payload),
        "num_words": total_words,
        "transcript_text": transcript_text,
        "generation_params": generation_params,
    }
    meta = {k: v for k, v in meta.items() if v is not None}

    result: dict[str, Any] = {
        "meta": meta,
        "segments": segments_payload,
    }

    return result


def main() -> int:
    args = parse_args()
    handler = TqdmLoggingHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)

    audio_files = ensure_audio_files(args.audio)
    if not audio_files:
        logging.info("No audio files provided; nothing to do.")
        return 0

    default_config = select_transcription_workflow(
        "faster-whisper",
        model_name=args.model,
        language=args.language,
    )
    model_name = args.model or default_config.model_name
    language_setting = resolve_language_setting(args.language, default_config.language)
    language = resolve_inference_language(language_setting)
    model_reference = resolve_model_reference(model_name)
    vad_model = args.vad_model or default_config.vad_model
    vad_model_label = vad_model
    if vad_model_label and not vad_model_label.endswith(".onnx"):
        vad_model_label = f"{vad_model_label}.onnx"

    bundle_root = resolve_bundle_root(
        args.output_dir,
        model_name=model_name,
        vad_model=vad_model,
        language=language_setting,
    )

    logging.info(
        "Loading faster-whisper model %s on %s (%s)",
        model_reference,
        args.device,
        args.compute_type,
    )
    model = WhisperModel(model_reference, device=args.device, compute_type=args.compute_type)
    pipeline = BatchedInferencePipeline(model=model)

    progress = tqdm(
        audio_files,
        desc="Transcribing files",
        unit="file",
        ncols=100,
        leave=False,
    )
    for audio_path in progress:
        progress.set_postfix_str(audio_path.name)
        logging.info("Transcribing %s", audio_path)

        min_silence_ms = config.vad.min_silence_ms

        # The batched pipeline runs its own VAD pass while decoding; the regions
        # it decodes are recorded in generation_params.transcription_options.
        # The options are shared with eval_faster_whisper.py so evaluations
        # decode the way production does.
        segments_iter, info = pipeline.transcribe(
            str(audio_path),
            **production_transcribe_options(language=language, batch_size=args.batch_size),
        )
        segments = list(segments_iter)
        duration_after_vad = getattr(info, "duration_after_vad", None)
        if duration_after_vad is not None:
            logging.info(
                "VAD kept %.1f s of %.1f s for %s",
                duration_after_vad,
                getattr(info, "duration", 0.0) or 0.0,
                audio_path.name,
            )
        payload = build_payload(
            audio_path,
            model_name=model_name,
            device=args.device,
            compute_type=args.compute_type,
            language=language,
            batch_size=args.batch_size,
            vad_filter=config.vad.filter_enabled,
            min_silence_ms=min_silence_ms,
            word_timestamps=config.vad.word_timestamps,
            vad_model=vad_model_label,
            info=info,
            segments=segments,
        )

        hash_component = require_valid_hash_stem(audio_path)
        target_dir = bundle_root / hash_component
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / "transcript.json"
        serialized = json.dumps(payload, ensure_ascii=False, indent=2)
        atomic_write_text(target_path, serialized, encoding="utf-8")
        logging.info(
            "Completed %s -> %s (%d segments)", audio_path.name, target_path, len(segments)
        )
    progress.close()

    logging.info("Processed %d file(s) into %s", len(audio_files), bundle_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
