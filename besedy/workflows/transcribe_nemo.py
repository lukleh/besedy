#!/usr/bin/env python3
"""Lightweight NeMo transcription CLI that applies frame-level VAD before decoding."""

from __future__ import annotations

import argparse
import json
import logging
import os
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Any

import torch
import yaml
from tqdm.auto import tqdm

from besedy.config.settings import config
from besedy.core.paths import (
    FRAME_VAD_CONFIG_PATH,
    FRAME_VAD_LOCAL_MODEL_PATH,
    require_valid_hash_stem,
    resolve_project_path,
    resolve_transcripts_root,
)
from besedy.lib.audio.probe import measure_audio_duration_seconds
from besedy.lib.nemo import (
    VadArtifacts,
    build_chunk_metadata,
    load_asr,
    load_audio,
    load_frame_vad,
    persist_vad_debug_artifacts,
    resolve_device,
    transcribe_segments,
)
from besedy.lib.nemo.segments import normalize_for_comparison
from besedy.lib.nemo.vad import run_vad_segmentation
from besedy.lib.workflow.config import (
    WorkflowConfig,
    get_workflow_label,
    select_transcription_workflow,
)
from besedy.lib.workflow.language import (
    resolve_language_setting,
    translation_language_setting,
    validate_workflow_language,
)
from besedy.lib.workflow.paths import sanitize_model_identifier

# Enable Flash Attention optimization for memory efficiency
# PyTorch 2.0+ will use Flash Attention v2 when available
torch.backends.cuda.enable_flash_sdp(True)
torch.backends.cuda.enable_mem_efficient_sdp(True)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_VAD_CONFIG = FRAME_VAD_CONFIG_PATH
LOCAL_VAD_MODEL = FRAME_VAD_LOCAL_MODEL_PATH

LOG_TEXT_NO_WORDS = os.getenv("NEMO_LOG_TEXT_NO_WORDS", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
try:
    LOG_TEXT_NO_WORDS_LIMIT = int(os.getenv("NEMO_LOG_TEXT_NO_WORDS_LIMIT", "25"))
except ValueError:
    LOG_TEXT_NO_WORDS_LIMIT = 25


# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------


def parse_arguments() -> argparse.Namespace:
    """Parse command-line arguments for NeMo transcription."""
    parser = argparse.ArgumentParser(
        description="Transcribe audio with NeMo ASR while masking non-speech using a frame VAD model.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--audio",
        type=Path,
        nargs="+",
        help="Audio file(s) to process. Provide WAV paths.",
    )
    parser.add_argument(
        "--audio-dir",
        type=Path,
        help="Directory to scan recursively for audio files.",
    )
    parser.add_argument(
        "--vad-model",
        type=str,
        default=None,
        help="Path to a .nemo VAD checkpoint or pretrained model name.",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Override the NeMo ASR model identifier.",
    )
    parser.add_argument(
        "--vad-config",
        type=Path,
        default=DEFAULT_VAD_CONFIG if DEFAULT_VAD_CONFIG.exists() else None,
        help="YAML file with VAD post-processing parameters (pad/onset thresholds, etc.).",
    )
    parser.add_argument(
        "--source-lang",
        type=str,
        default=None,
        help=(
            "Language code describing the input speech (forwarded to Canary prompts). "
            "Defaults to the configured workflow language."
        ),
    )
    parser.add_argument(
        "--target-lang",
        type=str,
        default=None,
        help=(
            "Desired transcription language code (forwarded to Canary prompts). "
            "Defaults to the configured workflow language."
        ),
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=1,
        help="Batch size for ASR decoding.",
    )
    parser.add_argument(
        "--decode-strategy",
        choices=("greedy", "beam"),
        default="greedy",
        help="Decoding strategy for NeMo ASR output.",
    )
    parser.add_argument(
        "--beam-size",
        type=int,
        default=2,
        help="Beam size when using beam decoding.",
    )
    parser.add_argument(
        "--softmax-temperature",
        type=float,
        default=1.0,
        help="Softmax temperature for beam decoding.",
    )
    parser.add_argument(
        "--beam-length-penalty",
        type=float,
        default=None,
        help="Length penalty (len_pen) for beam decoding. Uses model default when omitted.",
    )
    parser.add_argument(
        "--beam-max-generation-delta",
        type=int,
        default=None,
        help="Maximum output length delta for beam decoding. Uses model default when omitted.",
    )
    parser.add_argument(
        "--chunk-length",
        type=float,
        default=None,
        help=(
            "Maximum duration in seconds for any speech segment before it is split. "
            "Defaults to NeMo chunking defaults when omitted."
        ),
    )
    parser.add_argument(
        "--chunk-min-silence-ms",
        type=int,
        default=None,
        help=(
            "Minimum silence duration (ms) when searching for split points in overlong segments. "
            "Defaults to NeMo chunking defaults when omitted."
        ),
    )
    parser.add_argument(
        "--chunk-silence-threshold",
        type=float,
        default=None,
        help=(
            "Silence probability threshold applied when splitting overlong segments. "
            "Defaults to VAD postprocessing offset when omitted."
        ),
    )
    parser.add_argument(
        "--device",
        type=str,
        default="auto",
        help="Device for inference: 'cuda', 'cpu', or 'auto'.",
    )
    workflow_label = get_workflow_label("canary-nemo")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help=(
            "Base directory for per-file transcripts; defaults to "
            f"{config.paths.transcripts_dir}/{workflow_label}."
        ),
    )
    parser.add_argument(
        "--keep-vad-temp",
        action="store_true",
        help="Preserve intermediate VAD workspace directories for inspection.",
    )
    parser.add_argument(
        "--save-vad-debug",
        action="store_true",
        help="Persist VAD debug artifacts (segments.json, chunks.json, manifests). Disabled by default.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Log per-segment transcripts to stdout.",
    )
    return parser.parse_args()


def _default_nemo_config(
    decode_strategy: str,
    *,
    model_name: str | None = None,
    language: str | None = None,
) -> WorkflowConfig:
    workflow_id = "canary-nemo-beam" if decode_strategy == "beam" else "canary-nemo"
    return select_transcription_workflow(
        workflow_id,
        model_name=model_name,
        language=language,
    )


# ---------------------------------------------------------------------------
# VAD configuration
# ---------------------------------------------------------------------------


def _load_vad_config(path: Path | None) -> dict:
    """Load VAD configuration from YAML file."""
    if path is None:
        return {}
    if not path.exists():
        raise FileNotFoundError(f"VAD config file not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def _resolve_vad_parameters(args: argparse.Namespace) -> dict:
    """Resolve VAD parameters from config file."""
    config = _load_vad_config(args.vad_config)
    return config


# ---------------------------------------------------------------------------
# File collection
# ---------------------------------------------------------------------------


def _is_hidden(path: Path) -> bool:
    """Check if path contains hidden components."""
    return any(part.startswith(".") for part in path.parts if part not in ("/", ""))


def collect_audio_files(args: argparse.Namespace) -> list[Path]:
    """Collect audio files from arguments.

    Args:
        args: Parsed command-line arguments.

    Returns:
        Sorted list of unique audio file paths.

    Raises:
        ValueError: If no audio files found.
    """
    candidates: list[Path] = []
    if args.audio:
        candidates.extend(args.audio)
    if args.audio_dir:
        candidates.extend(args.audio_dir.rglob("*.wav"))
    unique_files = sorted(
        {
            resolved
            for path in candidates
            if path.exists()
            and path.is_file()
            and path.suffix.lower() == ".wav"
            and not _is_hidden(path)
            and not _is_hidden(resolved := path.resolve())
        }
    )
    if not unique_files:
        raise ValueError("No audio files found. Provide --audio or --audio-dir with WAV files.")
    return unique_files


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """Main entry point for NeMo transcription CLI."""
    args = parse_arguments()
    vad_cfg = _resolve_vad_parameters(args)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    device = resolve_device(args.device)
    default_config = _default_nemo_config(
        args.decode_strategy,
        model_name=args.model,
        language=args.target_lang or args.source_lang,
    )
    vad_label = default_config.vad_model
    workflow_label = default_config.workflow_label
    source_lang = resolve_language_setting(args.source_lang, default_config.language)
    target_lang = resolve_language_setting(args.target_lang, default_config.language)
    # Same rule the config loader enforces: Canary prompts need concrete languages.
    validate_workflow_language(default_config.workflow_id, source_lang, None, context="this run:")
    validate_workflow_language(default_config.workflow_id, target_lang, None, context="this run:")
    model_name = args.model or default_config.model_name
    align_model = default_config.align_model if args.decode_strategy == "beam" else None
    vad_model_source = args.vad_model
    if vad_model_source is None:
        if LOCAL_VAD_MODEL.exists():
            vad_model_source = str(LOCAL_VAD_MODEL)
        else:
            vad_model_source = vad_label
    if vad_model_source is None:
        raise RuntimeError("No VAD model source could be resolved.")
    # Translation runs (source != target) must not share output paths with
    # native transcriptions of the target language.
    workflow_config = replace(
        default_config,
        model_name=model_name,
        vad_model=vad_label,
        align_model=align_model,
        decode_strategy=args.decode_strategy,
        language=translation_language_setting(source_lang, target_lang),
    )
    output_component = workflow_config.output_component(sanitize_model_identifier)
    if args.output_dir:
        workflow_root = resolve_project_path(args.output_dir)
    else:
        workflow_root = resolve_transcripts_root(None) / workflow_label
    bundle_root = workflow_root / output_component
    bundle_root.mkdir(parents=True, exist_ok=True)
    vad_debug_bundle_root = bundle_root

    logging.info("Loading VAD model %s on %s", vad_model_source, device)
    vad_model = load_frame_vad(vad_model_source, device)
    vad_model.eval()

    logging.info("Loading ASR model %s on %s", model_name, device)
    asr_model = load_asr(
        model_name,
        device,
        decode_strategy=args.decode_strategy,
        beam_size=args.beam_size,
        softmax_temperature=args.softmax_temperature,
        beam_length_penalty=args.beam_length_penalty,
        beam_max_generation_delta=args.beam_max_generation_delta,
    )

    audio_files = collect_audio_files(args)
    logging.info("Discovered %d audio file(s).", len(audio_files))

    keep_vad_temp = getattr(args, "keep_vad_temp", False)
    with tempfile.TemporaryDirectory(prefix="nemo_vad_", delete=not keep_vad_temp) as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        artifacts_map, frame_unit, vad_workspace = run_vad_segmentation(
            audio_files=audio_files,
            vad_model=vad_model,
            vad_cfg=vad_cfg,
            args=args,
            workspace_dir=tmp_dir,
        )

        if device.type == "cuda":
            vad_model.to("cpu")

        # Process each audio file with file-level progress bar
        for audio_path in tqdm(
            audio_files, desc="Processing files", unit="file", position=0, leave=True
        ):
            logging.info("=" * 80)
            logging.info("Processing: %s", audio_path)

            source_duration = measure_audio_duration_seconds(audio_path)
            logging.info("Audio duration (ffprobe): %.2f seconds", source_duration)

            waveform = load_audio(audio_path, config.audio.sample_rate)
            total_duration = (
                waveform.shape[-1] / config.audio.sample_rate if waveform.numel() else 0.0
            )
            logging.info("Audio duration: %.2f seconds", total_duration)

            hash_component = require_valid_hash_stem(audio_path)
            vad_debug_dir = vad_debug_bundle_root / hash_component / "vad"

            resolved_path = audio_path.resolve()
            artifacts = artifacts_map.get(resolved_path, VadArtifacts())
            segments = list(artifacts.segments)

            used_fallback = False
            if not segments:
                logging.warning(
                    "VAD detected no speech in %s; transcribing full audio.", audio_path
                )
                fallback_segments = [
                    {
                        "start": 0.0,
                        "end": total_duration,
                        "chunk_alias": None,
                    }
                ]
                artifacts = VadArtifacts(segments=fallback_segments, chunks=artifacts.chunks)
                segments = fallback_segments
                used_fallback = True
            else:
                logging.info(
                    "Detected %d speech segment(s) - starting transcription...", len(segments)
                )

            segment_results = transcribe_segments(
                waveform=waveform,
                asr_model=asr_model,
                artifacts=artifacts,
                frame_unit=frame_unit,
                batch_size=args.batch_size,
                sample_rate=config.audio.sample_rate,
                source_lang=source_lang,
                target_lang=target_lang,
            )

            chunk_metadata = build_chunk_metadata(list(artifacts.chunks), total_duration)
            if args.save_vad_debug:
                persist_vad_debug_artifacts(
                    target_dir=vad_debug_dir,
                    manifests=vad_workspace,
                    artifacts=artifacts,
                    chunk_metadata=chunk_metadata,
                )

            transcript = " ".join(seg.text for seg in segment_results if seg.text).strip()
            segments_payload: list[dict] = []
            broken_segments: list[dict] = []
            previous_end = None
            missing_word_logs = 0
            for seg_idx, seg in enumerate(segment_results):
                segment_payload = seg.to_dict(previous_end=previous_end)
                segments_payload.append(segment_payload)
                previous_end = segment_payload["end"]

                reasons: list[str] = []
                text_value = segment_payload.get("text", "")
                words_value = segment_payload.get("words") or []
                raw_words = seg.words if isinstance(seg.words, list) else []

                if not text_value:
                    reasons.append("segment_text_empty")

                if text_value and not words_value:
                    if raw_words:
                        reasons.append("word_timestamps_missing")
                    else:
                        reasons.append("words_missing")

                if words_value and not text_value:
                    reasons.append("segment_text_missing")

                if raw_words:
                    missing_word_text = [
                        entry
                        for entry in raw_words
                        if not str(entry.get("word") or entry.get("text") or "").strip()
                    ]
                    if missing_word_text:
                        reasons.append("word_text_empty")
                    missing_timestamps = [
                        entry
                        for entry in raw_words
                        if isinstance(entry, dict)
                        and all(
                            entry.get(field) is None
                            for field in ("start", "start_time", "end", "end_time")
                        )
                    ]
                    if missing_timestamps:
                        reasons.append("word_timestamps_missing")

                if words_value:
                    normalized_segment = normalize_for_comparison(text_value)
                    normalized_words = normalize_for_comparison(
                        " ".join(word.get("word", "") for word in words_value)
                    )
                    if (
                        normalized_segment
                        and normalized_words
                        and normalized_segment != normalized_words
                    ):
                        reasons.append("text_words_mismatch")

                if (
                    LOG_TEXT_NO_WORDS
                    and text_value
                    and not words_value
                    and missing_word_logs < LOG_TEXT_NO_WORDS_LIMIT
                ):
                    _log_missing_words_diagnostic(seg, raw_words)
                    missing_word_logs += 1

                if reasons:
                    broken_segments.append(
                        {
                            "index": seg_idx,
                            "start": segment_payload["start"],
                            "end": segment_payload["end"],
                            "text_preview": text_value[:160],
                            "reasons": sorted(set(reasons)),
                        }
                    )

            total_words = sum(len(seg["words"]) for seg in segments_payload)
            if LOG_TEXT_NO_WORDS and missing_word_logs:
                logging.warning(
                    "File %s: %d segment(s) contained text without canonical words",
                    audio_path.name,
                    missing_word_logs,
                )

            if args.verbose:
                for seg in segment_results:
                    logging.debug(
                        "Segment %.2f-%.2f (conf=%.4f): %s",
                        seg.time_start,
                        seg.time_end,
                        seg.mean_probability if seg.mean_probability is not None else float("nan"),
                        seg.text,
                    )

            post_params = getattr(args, "_vad_postprocessing_params", {})
            pad_onset = post_params.get("pad_onset")
            pad_offset = post_params.get("pad_offset")
            pad_seconds = pad_onset if pad_onset is not None and pad_onset == pad_offset else None

            generation_params = {
                "vad_model": args.vad_model,
                "source_lang": source_lang,
                "target_lang": target_lang,
                "batch_size": args.batch_size,
                "decode_strategy": args.decode_strategy,
                "beam_size": args.beam_size if args.decode_strategy == "beam" else None,
                "softmax_temperature": (
                    args.softmax_temperature if args.decode_strategy == "beam" else None
                ),
                "beam_length_penalty": (
                    args.beam_length_penalty if args.decode_strategy == "beam" else None
                ),
                "beam_max_generation_delta": (
                    args.beam_max_generation_delta if args.decode_strategy == "beam" else None
                ),
                "chunk_length": (
                    float(args.chunk_length) if args.chunk_length is not None else None
                ),
                "chunk_min_silence_ms": (
                    int(args.chunk_min_silence_ms)
                    if args.chunk_min_silence_ms is not None
                    else None
                ),
                "chunk_silence_threshold": getattr(
                    args, "_chunking_effective_silence_threshold", None
                ),
                "speech_threshold": post_params.get("onset"),
                "speech_offset_threshold": post_params.get("offset"),
                "min_speech_duration": post_params.get("min_duration_on"),
                "min_silence_gap": post_params.get("min_duration_off"),
                "pad_onset": pad_onset,
                "pad_offset": pad_offset,
                "pad_seconds": pad_seconds,
                "frame_unit": frame_unit,
                "num_vad_segments": len(segments),
                "chunk_count": len(chunk_metadata),
                "vad_used_fallback": used_fallback,
            }
            generation_params = {k: v for k, v in generation_params.items() if v is not None}

            meta_backend = "canary-nemo-beam" if args.decode_strategy == "beam" else "canary-nemo"
            meta = {
                "backend": meta_backend,
                "model": model_name,
                "audio_filepath": str(audio_path),
                "duration": round(source_duration, 3),
                "num_segments": len(segments_payload),
                "num_words": total_words,
                "transcript_text": transcript,
                "generation_params": generation_params,
            }
            if used_fallback:
                meta["notes"] = "VAD fallback to entire clip."

            audio_component = hash_component
            target_dir = bundle_root / audio_component
            target_dir.mkdir(parents=True, exist_ok=True)
            target_path = target_dir / "transcript.json"
            if args.decode_strategy != "beam":
                payload = {
                    "meta": meta,
                    "segments": segments_payload,
                }
                if broken_segments:
                    payload["broken_segments"] = broken_segments
                target_path.write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                logging.info("Completed: Transcript written to %s", target_path)
            if args.decode_strategy == "beam":
                beam_segments = [
                    {
                        "start": segment["start"],
                        "end": segment["end"],
                        "text": segment.get("text", ""),
                    }
                    for segment in segments_payload
                ]
                beam_payload = {
                    "language": target_lang,
                    "segments": beam_segments,
                    "meta": {
                        "audio_filepath": str(audio_path),
                        "backend": meta.get("backend"),
                        "model": meta.get("model"),
                        "decode_strategy": args.decode_strategy,
                        "beam_size": args.beam_size,
                        "softmax_temperature": args.softmax_temperature,
                        "beam_length_penalty": args.beam_length_penalty,
                        "beam_max_generation_delta": args.beam_max_generation_delta,
                    },
                }
                beam_path = target_dir / "nemo_beam_segments.json"
                beam_path.write_text(
                    json.dumps(beam_payload, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                logging.info("Saved beam segments: %s", beam_path)
            logging.info("=" * 80)

        logging.info("Processed %d files into %s", len(audio_files), bundle_root)


def _log_missing_words_diagnostic(seg: Any, raw_words: list[dict]) -> None:
    """Log diagnostic information when text is present but canonical words are missing."""
    timestamp_keys: list[str] | str | None = None
    timestamp_word_entries: Any | None = None
    segment_timestamp_entries = None
    if isinstance(seg.timestamps, dict):
        timestamp_keys = [str(key) for key in seg.timestamps.keys()]
        for key in ("word", "words"):
            entries = seg.timestamps.get(key)
            if entries:
                timestamp_word_entries = entries
                break
        segment_entries = seg.timestamps.get("segment")
        if segment_entries:
            segment_timestamp_entries = segment_entries
    elif seg.timestamps is not None:
        timestamp_keys = type(seg.timestamps).__name__

    if timestamp_word_entries is None:
        timestamp_word_count = 0
        timestamp_sample = None
    else:
        try:
            timestamp_word_count = len(timestamp_word_entries)  # type: ignore[arg-type]
        except TypeError:
            timestamp_word_count = None
        if isinstance(timestamp_word_entries, list):
            timestamp_sample = timestamp_word_entries[:1]
        elif isinstance(timestamp_word_entries, dict):
            timestamp_sample = list(timestamp_word_entries.items())[:1]
        else:
            timestamp_sample = timestamp_word_entries

    raw_word_count = len(raw_words) if raw_words else (1 if seg.words else 0)
    missing_timing = 0
    word_sample = None
    if raw_words:
        for entry in raw_words:
            if word_sample is None:
                word_sample = entry
            if isinstance(entry, dict):
                time_fields = (
                    entry.get("start"),
                    entry.get("start_time"),
                    entry.get("end"),
                    entry.get("end_time"),
                )
                if all(val is None for val in time_fields):
                    missing_timing += 1
            else:
                missing_timing += 1

    logging.warning(
        (
            "NeMo emitted text without canonical words | start=%.2f end=%.2f "
            "dur=%.2f chunk=%s raw_words=%d missing_timing=%d word_conf_len=%d "
            "timestamp_keys=%s timestamp_word_count=%s text_preview=%s"
        ),
        seg.time_start,
        seg.time_end,
        seg.time_end - seg.time_start,
        seg.chunk_idx,
        raw_word_count,
        missing_timing,
        len(seg.word_confidence) if seg.word_confidence else 0,
        timestamp_keys,
        timestamp_word_count,
        seg.text[:160],
    )
    if timestamp_sample is not None:
        logging.warning("  timestamp sample: %s", timestamp_sample)
    if segment_timestamp_entries is not None:
        if isinstance(segment_timestamp_entries, list):
            segment_sample = segment_timestamp_entries[:1]
        elif isinstance(segment_timestamp_entries, dict):
            segment_sample = list(segment_timestamp_entries.items())[:1]
        else:
            segment_sample = segment_timestamp_entries
        logging.warning("  segment timestamp sample: %s", segment_sample)
    if word_sample is not None:
        logging.warning("  raw word sample: %s", word_sample)


if __name__ == "__main__":
    main()
