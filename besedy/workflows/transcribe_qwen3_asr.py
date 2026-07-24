#!/usr/bin/env python3
"""Qwen3-ASR workflow with external Silero VAD and canonical transcript output.

This module owns the end-to-end transcript generation path for the Qwen3-ASR
backend: argument parsing, model/vad setup, audio chunking, decoding, and
canonical transcript serialization.
"""

from __future__ import annotations

import argparse
import json
import logging
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from tqdm.auto import tqdm

from besedy.config.settings import config
from besedy.core.paths import (
    require_valid_hash_stem,
    resolve_project_path,
    resolve_transcripts_root,
)
from besedy.lib.audio.probe import measure_audio_duration_seconds
from besedy.lib.workflow.config import select_transcription_workflow
from besedy.lib.workflow.language import (
    qwen_language_code,
    qwen_language_name,
    resolve_inference_language,
    resolve_language_setting,
)
from besedy.lib.workflow.paths import sanitize_model_identifier
from besedy.workflows.transcribe_qwen3_asr_helpers import (
    _build_qwen_model,
    _build_sanitized_generation_config,  # noqa: F401
    _build_segments_from_words,
    _clear_cuda_cache,
    _configure_generation_padding,
    _interpolated_words,
    _is_cuda_oom,
    _log_segment_preview,
    _resolve_min_waveform_samples,
    _resolve_segmenter_mode,
    _should_drop_short_decode_segment,
    _split_segments_by_max_duration,
    _word_items_from_alignment,
    extract_vad_segments,
)

QWEN3_SILERO_MIN_SILENCE_MS_DEFAULT = 500
QWEN3_SILERO_MIN_SPEECH_MS_DEFAULT = 250
QWEN3_ASR_MIN_WAVEFORM_SAMPLES_DEFAULT = 201


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Transcribe staged audio with Qwen3-ASR and write canonical transcript.json.",
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
        help="Root directory for transcripts; defaults to <repo>/transcripts/qwen3-asr.",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Qwen3-ASR model identifier or local path (e.g., Qwen/Qwen3-ASR-1.7B).",
    )
    parser.add_argument(
        "--vad-model",
        default=None,
        help="VAD model identifier used in output path metadata (e.g., silero_vad_v6).",
    )
    parser.add_argument(
        "--align-model",
        default=None,
        help=(
            "Optional forced aligner model identifier for word timestamps "
            "(e.g., Qwen/Qwen3-ForcedAligner-0.6B)."
        ),
    )
    parser.add_argument(
        "--device",
        default="cuda:0",
        help="Device passed to Qwen3-ASR (e.g., cuda:0, cpu).",
    )
    parser.add_argument(
        "--dtype",
        choices=("float16", "bfloat16", "float32"),
        default="bfloat16",
        help="Torch dtype used when loading Qwen3-ASR and optional forced aligner.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=8,
        help="Batch size limit for Qwen3-ASR inference.",
    )
    parser.add_argument(
        "--max-new-tokens",
        type=int,
        default=512,
        help="Maximum generated tokens per ASR call.",
    )
    parser.add_argument(
        "--language",
        default=None,
        help=(
            "ISO 639 language code, translated to the language name Qwen3-ASR expects. "
            "Use 'auto' for language detection; defaults to the configured workflow language."
        ),
    )
    parser.add_argument(
        "--word-timestamps",
        dest="word_timestamps",
        action="store_true",
        default=config.vad.word_timestamps,
        help="Request word timestamps using forced aligner when --align-model is provided.",
    )
    parser.add_argument(
        "--no-word-timestamps",
        dest="word_timestamps",
        action="store_false",
        help="Disable forced-aligner timestamps and use interpolated word timings only.",
    )
    parser.add_argument(
        "--min-silence-ms",
        type=int,
        default=QWEN3_SILERO_MIN_SILENCE_MS_DEFAULT,
        help=(
            "Minimum silence duration (ms) used by Silero VAD. "
            f"Defaults to {QWEN3_SILERO_MIN_SILENCE_MS_DEFAULT} for qwen3-asr."
        ),
    )
    parser.add_argument(
        "--min-speech-ms",
        type=int,
        default=QWEN3_SILERO_MIN_SPEECH_MS_DEFAULT,
        help=(
            "Minimum speech duration (ms) used by Silero VAD. "
            "Chunks shorter than this are discarded by Silero."
        ),
    )
    parser.add_argument(
        "--speech-threshold",
        type=float,
        default=0.5,
        help="Speech threshold for Silero VAD (higher = stricter speech detection).",
    )
    parser.add_argument(
        "--segmenter",
        choices=("auto", "qwen-builtin", "silero-vad"),
        default="auto",
        help=(
            "Segmentation mode. auto = silero-vad (stable default for long files). "
            "qwen-builtin runs full-audio decode and may require high VRAM."
        ),
    )
    parser.add_argument(
        "--segment-max-gap",
        type=float,
        default=0.8,
        help="When using qwen-builtin, split output segments on inter-word gaps above this threshold (seconds).",
    )
    parser.add_argument(
        "--segment-max-duration",
        type=float,
        default=30.0,
        help="When using qwen-builtin, split output segments longer than this duration (seconds).",
    )
    parser.add_argument(
        "--silero-max-segment-seconds",
        type=float,
        default=90.0,
        help="Maximum segment duration for silero-vad decode path (proactively split longer segments).",
    )
    parser.add_argument(
        "--log-segments",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Print segment-level transcript snippets while processing.",
    )
    return parser.parse_args()


def resolve_bundle_root(
    output_dir: Path | None,
    *,
    model_name: str,
    vad_model: str | None = None,
    align_model: str | None = None,
    language: str,
) -> Path:
    base_config = select_transcription_workflow("qwen3-asr")
    workflow_config = replace(
        base_config,
        model_name=model_name,
        vad_model=vad_model,
        align_model=align_model,
        language=language,
    )
    output_component = workflow_config.output_component(sanitize_model_identifier)

    if output_dir is not None:
        workflow_root = resolve_project_path(output_dir)
    else:
        workflow_root = resolve_transcripts_root(None) / base_config.workflow_label

    target_root = workflow_root / output_component
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


def load_audio_mono_16k(path: Path) -> np.ndarray:
    wav, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if isinstance(wav, np.ndarray) and wav.ndim == 2:
        wav = np.mean(wav, axis=1).astype(np.float32)
    elif not isinstance(wav, np.ndarray):
        wav = np.asarray(wav, dtype=np.float32)
    if sr != config.audio.sample_rate:
        raise ValueError(
            f"Expected staged audio at {config.audio.sample_rate}Hz, got {sr}Hz for {path}. "
            "Run 'just catalog stage-audio' first."
        )
    return wav


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args()

    audio_files = ensure_audio_files(args.audio)
    if not audio_files:
        logging.info("No audio files provided; nothing to do.")
        return 0

    default_config = select_transcription_workflow(
        "qwen3-asr",
        model_name=args.model,
        language=args.language,
    )
    model_name = args.model or default_config.model_name
    vad_model_label = args.vad_model or default_config.vad_model or "silero_vad"
    align_model = args.align_model or default_config.align_model
    language_setting = resolve_language_setting(args.language, default_config.language)
    language = resolve_inference_language(language_setting)
    # Config and output paths speak ISO codes; Qwen3-ASR validates full names.
    qwen_language = qwen_language_name(language)
    min_silence_ms = (
        int(args.min_silence_ms)
        if args.min_silence_ms is not None
        else QWEN3_SILERO_MIN_SILENCE_MS_DEFAULT
    )
    min_speech_ms = (
        int(args.min_speech_ms)
        if args.min_speech_ms is not None
        else QWEN3_SILERO_MIN_SPEECH_MS_DEFAULT
    )
    request_timestamps = bool(align_model and args.word_timestamps)
    segmenter_mode = _resolve_segmenter_mode(
        requested=str(args.segmenter),
        request_timestamps=request_timestamps,
        vad_filter_enabled=bool(config.vad.filter_enabled),
    )

    if args.word_timestamps and not align_model:
        logging.info(
            "Word timestamps requested but no align_model is configured; "
            "Qwen3-ASR will run without forced-aligner timestamps."
        )

    bundle_root = resolve_bundle_root(
        args.output_dir,
        model_name=model_name,
        vad_model=vad_model_label,
        align_model=align_model,
        language=language_setting,
    )

    logging.info("Loading Qwen3-ASR model %s on %s (%s)", model_name, args.device, args.dtype)
    asr_model = _build_qwen_model(
        model_name=model_name,
        device=args.device,
        dtype=args.dtype,
        batch_size=args.batch_size,
        max_new_tokens=args.max_new_tokens,
        align_model=align_model,
    )
    _configure_generation_padding(asr_model)
    min_waveform_samples = _resolve_min_waveform_samples(asr_model)
    detected_languages: set[str] = set()

    def _record_detected_language(result: Any) -> None:
        detected = str(getattr(result, "language", "") or "").strip()
        if detected:
            detected_languages.add(qwen_language_code(detected) or detected)

    silero_vad = None

    def _ensure_silero_vad_loaded() -> Any:
        nonlocal silero_vad
        if silero_vad is None:
            from silero_vad import load_silero_vad

            logging.info("Loading Silero VAD model for external segmentation")
            silero_vad = load_silero_vad()
        return silero_vad

    def _transcribe_with_silero_segments(
        *,
        audio_path: Path,
        audio: np.ndarray,
        duration_seconds: float,
        timestamps_enabled: bool,
        max_segment_seconds: float,
    ) -> tuple[list[dict[str, Any]], list[dict[str, float]], int, bool, int]:
        vad_model = _ensure_silero_vad_loaded()

        if config.vad.filter_enabled:
            vad_segments_local = extract_vad_segments(
                audio,
                vad_model=vad_model,
                min_silence_duration_ms=min_silence_ms,
                min_speech_duration_ms=min_speech_ms,
                speech_threshold=float(args.speech_threshold),
                sample_rate=config.audio.sample_rate,
            )
        else:
            vad_segments_local = []

        vad_used_fallback_local = False
        if not vad_segments_local:
            vad_segments_local = [{"start": 0.0, "end": round(duration_seconds, 6)}]
            vad_used_fallback_local = True

        vad_segments_local = _split_segments_by_max_duration(
            vad_segments_local,
            max_segment_seconds=max_segment_seconds,
        )
        if not vad_segments_local and duration_seconds > 0:
            vad_segments_local = [{"start": 0.0, "end": round(duration_seconds, 6)}]
            vad_used_fallback_local = True

        segments_payload_local: list[dict[str, Any]] = []
        align_fallback_local = 0
        dropped_short_segments_local = 0
        previous_end: float | None = None
        for seg in vad_segments_local:
            start = float(seg["start"])
            end = float(seg["end"])
            if previous_end is not None and start < previous_end:
                start = previous_end
            if end < start:
                end = start

            start_idx = max(0, int(round(start * config.audio.sample_rate)))
            end_idx = min(len(audio), int(round(end * config.audio.sample_rate)))
            if end_idx <= start_idx:
                continue

            segment_num_samples = end_idx - start_idx
            if _should_drop_short_decode_segment(
                num_samples=segment_num_samples,
                min_samples=min_waveform_samples,
            ):
                dropped_short_segments_local += 1
                logging.debug(
                    "Dropping short segment for %s %.2f-%.2f (%d samples < %d)",
                    audio_path.name,
                    start,
                    end,
                    segment_num_samples,
                    min_waveform_samples,
                )
                previous_end = end
                continue

            audio_segment = audio[start_idx:end_idx]

            try:
                result = asr_model.transcribe(
                    audio=(audio_segment, config.audio.sample_rate),
                    language=qwen_language,
                    return_time_stamps=timestamps_enabled,
                )[0]
            except Exception as exc:
                if timestamps_enabled:
                    align_fallback_local += 1
                    logging.warning(
                        "Forced aligner failed for %s segment %.2f-%.2f: %s. Retrying without timestamps.",
                        audio_path.name,
                        start,
                        end,
                        exc,
                    )
                    if _is_cuda_oom(exc):
                        _clear_cuda_cache()
                    result = asr_model.transcribe(
                        audio=(audio_segment, config.audio.sample_rate),
                        language=qwen_language,
                        return_time_stamps=False,
                    )[0]
                else:
                    raise

            _record_detected_language(result)
            text = str(getattr(result, "text", "") or "").strip()
            if not text:
                previous_end = end
                continue

            words = _word_items_from_alignment(
                alignment=getattr(result, "time_stamps", None),
                segment_start=start,
                segment_end=end,
            )
            if not words:
                words = _interpolated_words(text, start, end)

            segments_payload_local.append(
                {
                    "start": round(start, 6),
                    "end": round(end, 6),
                    "text": text,
                    "confidence": None,
                    "words": words,
                }
            )
            if args.log_segments:
                _log_segment_preview(audio_path.name, start, end, text)
            previous_end = end

        return (
            segments_payload_local,
            vad_segments_local,
            align_fallback_local,
            vad_used_fallback_local,
            dropped_short_segments_local,
        )

    if segmenter_mode == "silero-vad":
        _ensure_silero_vad_loaded()

    logging.info(
        "Qwen3-ASR segmentation mode: %s (forced-aligner timestamps=%s)",
        segmenter_mode,
        request_timestamps,
    )

    progress = tqdm(
        audio_files,
        desc="Transcribing files",
        unit="file",
        ncols=100,
        leave=False,
    )
    for audio_path in progress:
        detected_languages = set()
        progress.set_postfix_str(audio_path.name)
        audio = load_audio_mono_16k(audio_path)
        duration_seconds = len(audio) / float(config.audio.sample_rate)

        effective_segmenter_mode = segmenter_mode
        segmenter_fallback_reason: str | None = None
        word_timestamps_active = request_timestamps

        vad_segments: list[dict[str, float]] = []
        segments_payload: list[dict[str, Any]] = []
        align_fallback_count = 0
        dropped_short_segments = 0
        vad_used_fallback = False

        if segmenter_mode == "qwen-builtin":
            result: Any | None = None
            try:
                result = asr_model.transcribe(
                    audio=(audio, config.audio.sample_rate),
                    language=qwen_language,
                    return_time_stamps=request_timestamps,
                )[0]
            except Exception as exc:
                if request_timestamps:
                    align_fallback_count += 1
                    logging.warning(
                        "Forced aligner failed for %s full audio: %s. Retrying without timestamps.",
                        audio_path.name,
                        exc,
                    )
                    if _is_cuda_oom(exc):
                        _clear_cuda_cache()
                    try:
                        result = asr_model.transcribe(
                            audio=(audio, config.audio.sample_rate),
                            language=qwen_language,
                            return_time_stamps=False,
                        )[0]
                        word_timestamps_active = False
                    except Exception as retry_exc:
                        if _is_cuda_oom(exc) or _is_cuda_oom(retry_exc):
                            logging.warning(
                                "Qwen built-in full-audio decode OOM for %s. "
                                "Falling back to silero-vad segmented decode without timestamps.",
                                audio_path.name,
                            )
                            _clear_cuda_cache()
                            (
                                segments_payload,
                                vad_segments,
                                fallback_align_count,
                                vad_used_fallback,
                                fallback_dropped_short_segments,
                            ) = _transcribe_with_silero_segments(
                                audio_path=audio_path,
                                audio=audio,
                                duration_seconds=duration_seconds,
                                timestamps_enabled=False,
                                max_segment_seconds=float(args.silero_max_segment_seconds),
                            )
                            align_fallback_count += fallback_align_count
                            dropped_short_segments += fallback_dropped_short_segments
                            effective_segmenter_mode = "silero-vad"
                            segmenter_fallback_reason = "qwen-builtin-oom"
                            word_timestamps_active = False
                            result = None
                        else:
                            raise
                else:
                    if _is_cuda_oom(exc):
                        logging.warning(
                            "Qwen built-in full-audio decode OOM for %s. "
                            "Falling back to silero-vad segmented decode.",
                            audio_path.name,
                        )
                        _clear_cuda_cache()
                        (
                            segments_payload,
                            vad_segments,
                            fallback_align_count,
                            vad_used_fallback,
                            fallback_dropped_short_segments,
                        ) = _transcribe_with_silero_segments(
                            audio_path=audio_path,
                            audio=audio,
                            duration_seconds=duration_seconds,
                            timestamps_enabled=False,
                            max_segment_seconds=float(args.silero_max_segment_seconds),
                        )
                        align_fallback_count += fallback_align_count
                        dropped_short_segments += fallback_dropped_short_segments
                        effective_segmenter_mode = "silero-vad"
                        segmenter_fallback_reason = "qwen-builtin-oom"
                        word_timestamps_active = False
                        result = None
                    else:
                        raise

            if result is not None:
                _record_detected_language(result)
                text = str(getattr(result, "text", "") or "").strip()
                aligned_words = _word_items_from_alignment(
                    alignment=getattr(result, "time_stamps", None),
                    segment_start=0.0,
                    segment_end=duration_seconds,
                )
                if aligned_words:
                    segments_payload = _build_segments_from_words(
                        aligned_words,
                        max_gap_s=float(args.segment_max_gap),
                        max_duration_s=float(args.segment_max_duration),
                    )
                elif text:
                    segments_payload = [
                        {
                            "start": 0.0,
                            "end": round(duration_seconds, 6),
                            "text": text,
                            "confidence": None,
                            "words": _interpolated_words(text, 0.0, duration_seconds),
                        }
                    ]

                vad_segments = [
                    {"start": float(seg["start"]), "end": float(seg["end"])}
                    for seg in segments_payload
                ]
                if not vad_segments and duration_seconds > 0:
                    vad_segments = [{"start": 0.0, "end": round(duration_seconds, 6)}]
                    vad_used_fallback = True

                if args.log_segments:
                    for seg in segments_payload:
                        _log_segment_preview(
                            audio_path.name,
                            float(seg["start"]),
                            float(seg["end"]),
                            str(seg["text"]),
                        )
        else:
            (
                segments_payload,
                vad_segments,
                silero_align_fallbacks,
                vad_used_fallback,
                silero_dropped_short_segments,
            ) = _transcribe_with_silero_segments(
                audio_path=audio_path,
                audio=audio,
                duration_seconds=duration_seconds,
                timestamps_enabled=request_timestamps,
                max_segment_seconds=float(args.silero_max_segment_seconds),
            )
            align_fallback_count += silero_align_fallbacks
            dropped_short_segments += silero_dropped_short_segments
            effective_segmenter_mode = "silero-vad"

        transcript_text = " ".join(seg["text"] for seg in segments_payload if seg["text"]).strip()
        num_words = sum(len(seg["words"]) for seg in segments_payload)
        duration_val = measure_audio_duration_seconds(audio_path)
        detected_language_values = sorted(detected_languages)
        effective_language = language
        if effective_language is None and len(detected_language_values) == 1:
            effective_language = detected_language_values[0]

        generation_params = {
            "device": args.device,
            "dtype": args.dtype,
            "language": effective_language,
            "requested_language": language_setting,
            "detected_languages": detected_language_values or None,
            "batch_size": args.batch_size,
            "max_new_tokens": args.max_new_tokens,
            "segmenter_mode": effective_segmenter_mode,
            "segmenter_fallback_reason": segmenter_fallback_reason,
            "vad_filter": (
                config.vad.filter_enabled if effective_segmenter_mode == "silero-vad" else None
            ),
            "min_silence_duration_ms": (
                min_silence_ms if effective_segmenter_mode == "silero-vad" else None
            ),
            "min_speech_duration_ms": (
                min_speech_ms if effective_segmenter_mode == "silero-vad" else None
            ),
            "speech_threshold": (
                float(args.speech_threshold) if effective_segmenter_mode == "silero-vad" else None
            ),
            "silero_max_segment_seconds": (
                float(args.silero_max_segment_seconds)
                if effective_segmenter_mode == "silero-vad"
                else None
            ),
            "segment_max_gap": (
                float(args.segment_max_gap) if effective_segmenter_mode == "qwen-builtin" else None
            ),
            "segment_max_duration": (
                float(args.segment_max_duration)
                if effective_segmenter_mode == "qwen-builtin"
                else None
            ),
            "word_timestamps": bool(args.word_timestamps),
            "word_timestamps_active": word_timestamps_active,
            "vad_model": vad_model_label,
            "vad_runtime": (
                "silero-vad"
                if effective_segmenter_mode == "silero-vad"
                else "qwen-builtin-chunking"
            ),
            "align_model": align_model,
            "num_vad_segments": len(vad_segments),
            "vad_used_fallback": vad_used_fallback,
            "align_fallback_count": align_fallback_count,
            "dropped_short_segments": dropped_short_segments,
        }
        generation_params = {k: v for k, v in generation_params.items() if v is not None}

        payload = {
            "meta": {
                "backend": "qwen3-asr",
                "model": model_name,
                "audio_filepath": str(audio_path),
                "duration": round(duration_val, 3) if duration_val is not None else None,
                "num_segments": len(segments_payload),
                "num_words": num_words,
                "transcript_text": transcript_text,
                "generation_params": generation_params,
            },
            "segments": segments_payload,
            "vad_segments": vad_segments,
        }
        payload["meta"] = {k: v for k, v in payload["meta"].items() if v is not None}

        hash_component = require_valid_hash_stem(audio_path)
        target_dir = bundle_root / hash_component
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / "transcript.json"
        target_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        logging.info(
            "Completed %s -> %s (%d segments)",
            audio_path.name,
            target_path,
            len(segments_payload),
        )

    progress.close()
    logging.info("Processed %d file(s) into %s", len(audio_files), bundle_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
