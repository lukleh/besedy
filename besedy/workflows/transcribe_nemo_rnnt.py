#!/usr/bin/env python3
"""Offline NeMo RNNT transcription with Silero VAD and native word timestamps."""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import math
import tempfile
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from besedy.config.settings import config
from besedy.core.paths import (
    require_valid_hash_stem,
    resolve_project_path,
    resolve_transcripts_root,
    validate_mono_wav_16k,
)
from besedy.lib.analysis.subtitles import render_srt, render_vtt
from besedy.lib.analysis.timeline import extract_segments
from besedy.lib.data.atomic_io import atomic_write_json, atomic_write_text
from besedy.lib.workflow.config import select_transcription_workflow
from besedy.lib.workflow.language import resolve_language_setting
from besedy.lib.workflow.paths import sanitize_model_identifier

SAMPLE_RATE = 16000
MAX_CHUNK_SECONDS = 30.0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, nargs="+", required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--model")
    parser.add_argument("--language")
    parser.add_argument("--vad-model")
    parser.add_argument("--device", default="cuda")
    return parser.parse_args(argv)


def resolve_bundle_root(output_dir: Path | None, workflow: Any) -> Path:
    workflow_root = (
        resolve_project_path(output_dir)
        if output_dir is not None
        else resolve_transcripts_root(None) / workflow.workflow_label
    )
    root = workflow_root / workflow.output_component(sanitize_model_identifier)
    root.mkdir(parents=True, exist_ok=True)
    return root


def bounded_regions(regions: list[dict[str, int]], total_samples: int) -> list[tuple[int, int]]:
    """Validate ordered VAD sample offsets and bound inference memory per chunk."""
    limit = int(MAX_CHUNK_SECONDS * SAMPLE_RATE)
    output: list[tuple[int, int]] = []
    previous_end = 0
    for region in regions:
        start, end = region["start"], region["end"]
        if not 0 <= previous_end <= start < end <= total_samples:
            raise ValueError(f"Invalid or overlapping VAD region {start}:{end}")
        while start < end:
            next_end = min(end, start + limit)
            output.append((start, next_end))
            start = next_end
        previous_end = end
    return output


def words_from_hypothesis(
    hypothesis: Any, *, start: float, end: float, frame_seconds: float
) -> list[dict[str, Any]]:
    """Map NeMo's already-converted chunk-relative seconds to recording time.

    NeMo ``transcribe(timestamps=True)`` calls ``process_timestamp_outputs``.
    Its ``start``/``end`` fields are seconds; multiplying them by the encoder
    frame stride again would produce plausible-looking but incorrect timing.
    Frame quantization may extend a final word by at most one encoder frame.
    """
    timestamp = getattr(hypothesis, "timestamp", None)
    raw_words = timestamp.get("word") if isinstance(timestamp, dict) else None
    if not isinstance(raw_words, list) or not raw_words:
        raise ValueError("RNNT returned text without native word timestamps")
    duration = end - start
    words: list[dict[str, Any]] = []
    previous_start = 0.0
    previous_end = 0.0
    for item in raw_words:
        text = str(item.get("word", "")).strip()
        if not text:
            continue
        local_start, local_end = float(item["start"]), float(item["end"])
        if (
            not math.isfinite(local_start)
            or not math.isfinite(local_end)
            or local_start < 0
            or local_end < local_start
            or local_start < previous_start
            or local_start > duration + frame_seconds + 1e-6
            or local_end > duration + frame_seconds + 1e-6
        ):
            raise ValueError(f"Invalid RNNT word timestamp {local_start}:{local_end}")
        previous_start = local_start
        # RNNT may emit multiple words on one encoder frame. Its token end is
        # frame+1, so consecutive native words can overlap by exactly one frame.
        # Match the canonical non-overlap contract without interpolating words.
        if previous_end - local_start > frame_seconds + 1e-6:
            raise ValueError("RNNT word overlap exceeds one encoder frame")
        local_start = max(local_start, previous_end)
        local_end = max(local_start, local_end)
        previous_end = local_end
        words.append(
            {
                "start": round(min(end, start + local_start), 6),
                "end": round(min(end, start + local_end), 6),
                "word": text,
                "confidence": None,
            }
        )
    if not words:
        raise ValueError("RNNT returned no usable timed words")
    return words


def load_model(model_name: str, device: str):
    import torch
    from nemo.collections.asr.models import ASRModel
    from omegaconf import OmegaConf

    path = Path(model_name).expanduser()
    if path.suffix == ".nemo" and path.is_file():
        model = ASRModel.restore_from(str(path), map_location=torch.device("cpu"))
    else:
        model = ASRModel.from_pretrained(model_name, map_location=torch.device("cpu"))
    if not hasattr(model, "joint") or "prompt_dictionary" not in model.cfg.model_defaults:
        raise TypeError("nemo-rnnt requires a prompt-conditioned NeMo RNNT checkpoint")
    decoding = OmegaConf.to_container(model.cfg.decoding, resolve=True)
    if not isinstance(decoding, dict):
        raise TypeError("RNNT decoding configuration must be a mapping")
    decoding["strategy"] = "greedy_batch"
    decoding["compute_timestamps"] = True
    decoding["rnnt_timestamp_type"] = "all"
    decoding.setdefault("greedy", {})["use_cuda_graph_decoder"] = False
    model.change_decoding_strategy(OmegaConf.create(decoding), verbose=False)
    return model.to(device).eval()


def transcribe_chunk(model: Any, waveform: Any, *, language: str, temporary: Path, device: str):
    import soundfile as sf
    import torch

    chunk_path = temporary / "chunk.wav"
    sf.write(str(chunk_path), waveform, SAMPLE_RATE, subtype="PCM_16")
    manifest = temporary / "input.jsonl"
    # Plain file-list input lost target_lang in older NeMo prompt loaders.
    # An explicit manifest also disables random auto-language prompt selection.
    manifest.write_text(
        json.dumps(
            {
                "audio_filepath": str(chunk_path),
                "duration": len(waveform) / SAMPLE_RATE,
                "text": "",
                "lang": language,
                "target_lang": language,
                "prompt_mode": "langID",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    autocast = (
        torch.autocast("cuda", dtype=torch.bfloat16)
        if device.startswith("cuda")
        else contextlib.nullcontext()
    )
    with torch.inference_mode(), autocast:
        hypotheses = model.transcribe(
            [str(manifest)],
            batch_size=1,
            num_workers=0,
            return_hypotheses=True,
            timestamps=True,
            target_lang=language,
            verbose=False,
        )
    if len(hypotheses) != 1:
        raise RuntimeError(f"Expected one RNNT hypothesis, got {len(hypotheses)}")
    return hypotheses[0]


def write_transcript(target: Path, payload: dict[str, Any]) -> None:
    target.mkdir(parents=True, exist_ok=True)
    segments = extract_segments(payload, source="nemo-rnnt")
    atomic_write_text(target / "transcript.txt", payload["meta"]["transcript_text"] + "\n")
    atomic_write_text(target / "transcript.srt", render_srt(segments))
    atomic_write_text(target / "transcript.vtt", render_vtt(segments))
    # Publish the pipeline completion marker after all sidecars are present.
    atomic_write_json(target / "transcript.json", payload, indent=2, ensure_ascii=False)


def transcribe_file(
    audio_path: Path, *, model: Any, vad: Any, workflow: Any, device: str, output: Path
) -> dict[str, Any]:
    import numpy as np
    import soundfile as sf
    import torch
    from silero_vad import get_speech_timestamps

    started = time.monotonic()
    audio_path = audio_path.expanduser().resolve(strict=True)
    hash_component = require_valid_hash_stem(audio_path)
    info = sf.info(str(audio_path))
    validate_mono_wav_16k(audio_path, info.samplerate, info.channels)
    audio, _ = sf.read(str(audio_path), dtype="float32")
    if not np.isfinite(audio).all():
        raise ValueError(f"Non-finite audio samples in {audio_path}")
    duration = len(audio) / SAMPLE_RATE
    min_silence_ms = config.vad.min_silence_ms
    if min_silence_ms is None:
        min_silence_ms = 500
    if config.vad.filter_enabled:
        regions = get_speech_timestamps(
            torch.as_tensor(audio),
            vad,
            sampling_rate=SAMPLE_RATE,
            min_silence_duration_ms=min_silence_ms,
            min_speech_duration_ms=250,
            max_speech_duration_s=MAX_CHUNK_SECONDS,
        )
    else:
        regions = [{"start": 0, "end": len(audio)}] if len(audio) else []
    chunks = bounded_regions(regions, len(audio))
    frame_seconds = float(model.cfg.preprocessor.window_stride) * model.encoder.subsampling_factor
    segments: list[dict[str, Any]] = []
    vad_segments = []
    with tempfile.TemporaryDirectory(prefix="besedy-nemo-rnnt-") as directory:
        temporary = Path(directory)
        for index, (first, last) in enumerate(chunks):
            start, end = first / SAMPLE_RATE, last / SAMPLE_RATE
            vad_segments.append({"start": start, "end": end})
            hypothesis = transcribe_chunk(
                model,
                audio[first:last],
                language=workflow.language,
                temporary=temporary,
                device=device,
            )
            text = (hypothesis.text or "").strip()
            if text:
                words = words_from_hypothesis(
                    hypothesis, start=start, end=end, frame_seconds=frame_seconds
                )
                segments.append(
                    {"start": start, "end": end, "text": text, "words": words, "confidence": None}
                )
            logging.info(
                "%s chunk %d/%d %.2f–%.2fs", audio_path.name, index + 1, len(chunks), start, end
            )
    payload = {
        "meta": {
            "backend": "nemo-rnnt",
            "model": workflow.model_name,
            "audio_filepath": str(audio_path),
            "duration": round(duration, 6),
            "num_segments": len(segments),
            "num_words": sum(len(s["words"]) for s in segments),
            "transcript_text": " ".join(s["text"] for s in segments),
            "generation_params": {
                "device": device,
                "language": workflow.language,
                "dtype": "bfloat16" if device.startswith("cuda") else "float32",
                "batch_size": 1,
                "vad_model": workflow.vad_model,
                "vad_filter": config.vad.filter_enabled,
                "min_silence_duration_ms": min_silence_ms,
                "min_speech_duration_ms": 250,
                "max_chunk_seconds": MAX_CHUNK_SECONDS,
                "word_timestamps": True,
                "timestamp_source": "native_rnnt",
                "native_word_overlap_policy": "clamp_up_to_one_encoder_frame",
                "encoder_frame_seconds": frame_seconds,
                "num_vad_segments": len(chunks),
                "speech_seconds": sum((last - first) / SAMPLE_RATE for first, last in chunks),
                "elapsed_seconds": round(time.monotonic() - started, 3),
            },
        },
        "segments": segments,
        "vad_segments": vad_segments,
    }
    write_transcript(output / hash_component, payload)
    return payload


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args(argv)
    configured = select_transcription_workflow(
        "nemo-rnnt", model_name=args.model, language=args.language
    )
    workflow = replace(
        configured,
        model_name=args.model or configured.model_name,
        language=resolve_language_setting(args.language, configured.language),
        vad_model=args.vad_model or configured.vad_model or "silero_vad_v6",
    )
    if workflow.vad_model != "silero_vad_v6":
        raise ValueError("nemo-rnnt currently supports vad_model='silero_vad_v6'")
    output = resolve_bundle_root(args.output_dir, workflow)
    model = load_model(workflow.model_name, args.device)
    if workflow.language not in model.cfg.model_defaults.prompt_dictionary:
        raise ValueError(f"RNNT checkpoint does not support language {workflow.language!r}")
    from silero_vad import load_silero_vad

    vad = load_silero_vad(onnx=True)
    for audio_path in args.audio:
        transcribe_file(
            audio_path,
            model=model,
            vad=vad,
            workflow=workflow,
            device=args.device,
            output=output,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
