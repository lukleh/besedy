#!/usr/bin/env python3
"""Decode bounded ARK-ASR chunks for a separate WhisperX word-alignment pass.

ARK-ASR has no native word timing or documented forced-language control. The
configured language identifies the output and the subsequent forced aligner;
the acoustic decoder uses the upstream neutral transcription prompt.
"""

from __future__ import annotations

import argparse
import logging
import re
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from besedy.config.settings import config
from besedy.core.paths import (
    require_valid_hash_stem,
    resolve_project_path,
    resolve_transcripts_root,
    validate_mono_wav_16k,
)
from besedy.lib.data.atomic_io import atomic_write_json
from besedy.lib.data.encoding import load_json_with_fallback
from besedy.lib.workflow.config import select_transcription_workflow
from besedy.lib.workflow.language import resolve_language_setting, validate_workflow_language
from besedy.lib.workflow.paths import sanitize_model_identifier

MODEL_ID = "Edge0/ARK-ASR-0.6B"
MODEL_REVISION = "45776b56d58cdfb2e2eb632f7e110f38684633e0"
SAMPLE_RATE = 16000
MAX_CHUNK_SECONDS = 30.0
MAX_NEW_TOKENS = 512
AUDIO_TOKEN_START = 151670
RAW_FILENAME = "ark_segments.json"
TURN_END_MARKERS = ("<|user|>", "<|assistant|>", "<|im_end|>")
SPECIAL_TOKEN_PATTERN = re.compile(
    r"<\|(?:bicodec_(?:semantic|global)_\d+|(?:start|end)_(?:global_token|glm_token|semantic_token|content))\|>"
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, nargs="+", required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--model")
    parser.add_argument("--revision", help="Immutable Hub commit for an alternate model repository")
    parser.add_argument(
        "--language", help="Output identity and alignment language; ARK detects speech language"
    )
    parser.add_argument("--vad-model")
    parser.add_argument("--align-model", help="Subsequent aligner, included in the output identity")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--skip-existing", action="store_true")
    return parser.parse_args(argv)


def resolve_bundle_root(output_dir: Path | None, workflow: Any) -> Path:
    workflow_root = (
        resolve_project_path(output_dir)
        if output_dir is not None
        else resolve_transcripts_root(None) / workflow.workflow_label
    )
    return workflow_root / workflow.output_component(sanitize_model_identifier)


def model_revision(model_name: str, revision: str | None = None) -> str:
    if Path(model_name).expanduser().is_dir():
        if revision is not None:
            raise ValueError("--revision cannot be applied to a local model directory")
        return "local"
    resolved = revision or (MODEL_REVISION if model_name == MODEL_ID else None)
    if resolved is None or re.fullmatch(r"[0-9a-f]{40}", resolved) is None:
        raise ValueError("An alternate Hub model requires --revision with its 40-character commit")
    return resolved


def bounded_regions(regions: list[dict[str, int]], total_samples: int) -> list[tuple[int, int]]:
    """Preserve speech offsets/gaps while bounding each decoder call to 30s."""
    limit = int(MAX_CHUNK_SECONDS * SAMPLE_RATE)
    chunks: list[tuple[int, int]] = []
    previous_end = 0
    for region in regions:
        first, last = region["start"], region["end"]
        if not 0 <= previous_end <= first < last <= total_samples:
            raise ValueError(f"Invalid or overlapping VAD region {first}:{last}")
        while first < last:
            end = min(last, first + limit)
            chunks.append((first, end))
            first = end
        previous_end = last
    return chunks


def normalize_prediction(text: str) -> str:
    for marker in TURN_END_MARKERS:
        text = text.split(marker, 1)[0]
    if "<|text|>" in text:
        text = text.split("<|text|>", 1)[1]
    text = SPECIAL_TOKEN_PATTERN.sub("", text)
    return re.sub(r"^[\s,.;:!?-]+", "", re.sub(r"\s+", " ", text)).strip()


def _token_ids(value: Any) -> list[int]:
    if value is None:
        return []
    return [int(item) for item in value] if isinstance(value, (list, tuple, set)) else [int(value)]


def generation_token_ids(model: Any, tokenizer: Any) -> tuple[list[int], list[int]]:
    """Keep true EOS usable while suppressing control/audio-token output."""
    eos = set(_token_ids(tokenizer.eos_token_id))
    for marker in TURN_END_MARKERS:
        token_id = tokenizer.convert_tokens_to_ids(marker)
        if isinstance(token_id, int) and token_id >= 0 and token_id != tokenizer.unk_token_id:
            eos.add(token_id)
    # Turn markers are defensive stop criteria, not valid ASR output tokens.
    # Leaving <|assistant|> unmasked makes this checkpoint stop immediately.
    keep = set(_token_ids(tokenizer.eos_token_id))
    keep.update(_token_ids(getattr(model.config, "eos_token_id", None)))
    keep.update(_token_ids(getattr(model.generation_config, "eos_token_id", None)))
    blocked = set(tokenizer.all_special_ids)
    for token_id, token in tokenizer.added_tokens_decoder.items():
        content = getattr(token, "content", "")
        if re.fullmatch(r"<.*>", content):
            blocked.add(int(token_id))
    return sorted(eos), sorted(blocked - keep)


class ASRTokenMask:
    """The upstream ARK ASR-only output mask, independent of model imports."""

    def __init__(self, blocked: list[int]):
        self.blocked = [item for item in blocked if 0 <= item < AUDIO_TOKEN_START]

    def __call__(self, input_ids: Any, scores: Any) -> Any:
        scores[:, AUDIO_TOKEN_START:] = -float("inf")
        valid = [item for item in self.blocked if 0 <= item < scores.shape[-1]]
        scores[:, valid] = -float("inf")
        return scores


@dataclass
class ArkRuntime:
    model: Any
    processor: Any
    tokenizer: Any
    device: str
    dtype: Any
    revision: str


def load_model(model_name: str, device: str, revision: str) -> ArkRuntime:
    import torch
    from huggingface_hub import snapshot_download
    from transformers import AutoModelForCausalLM, AutoProcessor, AutoTokenizer

    # This processor reads its nested configuration only from a local file.
    # Materialize a complete immutable snapshot instead of loading it by Hub ID.
    source = (
        str(Path(model_name).expanduser().resolve())
        if revision == "local"
        else snapshot_download(model_name, revision=revision)
    )
    dtype = torch.float16 if device.startswith("cuda") else torch.float32
    tokenizer = AutoTokenizer.from_pretrained(
        source, trust_remote_code=True, fix_mistral_regex=True
    )
    processor = AutoProcessor.from_pretrained(source, trust_remote_code=True)
    # Its custom loader does not forward the regex option to AutoTokenizer.
    # Encoding and decoding must use the same explicitly configured tokenizer.
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token_id = tokenizer.eos_token_id
    tokenizer.padding_side = "left"
    processor.tokenizer = tokenizer
    model = (
        AutoModelForCausalLM.from_pretrained(
            source,
            trust_remote_code=True,
            torch_dtype=dtype,
            attn_implementation="sdpa" if device.startswith("cuda") else "eager",
        )
        .to(device)
        .eval()
    )
    return ArkRuntime(model, processor, tokenizer, device, dtype, revision)


def transcribe_chunk(runtime: ArkRuntime, waveform: Any) -> str:
    import torch

    inputs = dict(
        runtime.processor.apply_chat_template(
            [
                [
                    {
                        "role": "user",
                        "content": [
                            {"type": "audio", "array": waveform},
                            {"type": "text", "text": "Please transcribe this audio."},
                        ],
                    }
                ]
            ],
            return_tensors="pt",
            sampling_rate=SAMPLE_RATE,
            audio_padding="longest",
            add_generation_prompt=True,
            text_kwargs={"padding": "longest"},
            audio_max_length=int(MAX_CHUNK_SECONDS * SAMPLE_RATE),
        )
    )
    if "audios" not in inputs or "input_ids" not in inputs:
        raise ValueError("ARK processor did not encode both audio and text")
    if "attention_mask" not in inputs:
        inputs["attention_mask"] = torch.ones_like(inputs["input_ids"])
    for key, value in inputs.items():
        if torch.is_tensor(value):
            inputs[key] = (
                value.to(device=runtime.device, dtype=runtime.dtype)
                if key == "audios"
                else value.to(runtime.device)
            )
    eos, blocked = generation_token_ids(runtime.model, runtime.tokenizer)
    with torch.inference_mode():
        output = runtime.model.generate(
            **inputs,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,
            use_cache=True,
            pad_token_id=runtime.tokenizer.pad_token_id,
            eos_token_id=eos,
            logits_processor=[ASRTokenMask(blocked)],
        )
    generated = output[0, inputs["input_ids"].shape[1] :]
    if len(generated) >= MAX_NEW_TOKENS and int(generated[-1]) not in eos:
        raise RuntimeError(
            "ARK reached the token limit; refusing to publish truncated transcription"
        )
    return normalize_prediction(runtime.tokenizer.decode(generated, skip_special_tokens=False))


def _identity(workflow: Any, revision: str) -> dict[str, Any]:
    return {
        "model_revision": revision,
        "code_revision": revision,
        "asr_language": "auto",
        "alignment_language": workflow.language,
        "align_model": workflow.align_model,
        "vad_model": workflow.vad_model,
        "vad_filter": config.vad.filter_enabled,
        "min_silence_duration_ms": config.vad.min_silence_ms
        if config.vad.min_silence_ms is not None
        else 500,
        "min_speech_duration_ms": 250,
        "max_chunk_seconds": MAX_CHUNK_SECONDS,
        "max_new_tokens": MAX_NEW_TOKENS,
    }


def raw_is_complete(path: Path, audio_path: Path, workflow: Any, revision: str) -> bool:
    """Do not mistake interrupted/stale output for a resumable ASR result."""
    try:
        raw = load_json_with_fallback(path)
        if not isinstance(raw, dict) or not isinstance(raw.get("meta"), dict):
            return False
        meta = raw["meta"]
        params = meta.get("generation_params")
        if not isinstance(params, dict):
            return False
        if meta["backend"] != "ark-asr" or meta["model"] != workflow.model_name:
            return False
        if meta["audio_filepath"] != str(audio_path) or not all(
            params.get(key) == value for key, value in _identity(workflow, revision).items()
        ):
            return False
        stat = audio_path.stat()
        if meta.get("source_file") != {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns}:
            return False
        previous_end = 0.0
        for segment in raw["segments"]:
            if not 0 <= previous_end <= segment["start"] < segment["end"] <= meta["duration"]:
                return False
            if not isinstance(segment["text"], str) or not segment["text"].strip():
                return False
            previous_end = segment["end"]
        return isinstance(raw["segments"], list) and isinstance(raw["vad_segments"], list)
    except (OSError, ValueError, KeyError, TypeError):
        return False


def transcribe_file(
    audio_path: Path, *, runtime: ArkRuntime, vad: Any, workflow: Any, output: Path
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
    if info.samplerate != SAMPLE_RATE:
        raise ValueError("ARK-ASR requires 16000 Hz audio")
    audio, _ = sf.read(str(audio_path), dtype="float32")
    if not np.isfinite(audio).all():
        raise ValueError(f"Non-finite audio samples in {audio_path}")
    duration = len(audio) / SAMPLE_RATE
    params = _identity(workflow, runtime.revision)
    if config.vad.filter_enabled:
        regions = get_speech_timestamps(
            torch.as_tensor(audio),
            vad,
            sampling_rate=SAMPLE_RATE,
            min_silence_duration_ms=params["min_silence_duration_ms"],
            min_speech_duration_ms=250,
            max_speech_duration_s=MAX_CHUNK_SECONDS,
        )
    else:
        regions = [{"start": 0, "end": len(audio)}] if len(audio) else []
    chunks = bounded_regions(regions, len(audio))
    segments = []
    for index, (first, last) in enumerate(chunks):
        logging.info(
            "%s chunk %d/%d %.3f–%.3fs",
            audio_path.name,
            index + 1,
            len(chunks),
            first / SAMPLE_RATE,
            last / SAMPLE_RATE,
        )
        text = transcribe_chunk(runtime, audio[first:last])
        if text:
            segments.append({"start": first / SAMPLE_RATE, "end": last / SAMPLE_RATE, "text": text})
    stat = audio_path.stat()
    params.update(
        {
            "device": runtime.device,
            "dtype": "float16" if runtime.device.startswith("cuda") else "float32",
            "do_sample": False,
            "use_cache": True,
            "word_timestamps": False,
            "timestamp_source": "vad_chunk_boundaries",
            "batch_size": 1,
            "num_vad_segments": len(chunks),
            "speech_seconds": sum(last - first for first, last in chunks) / SAMPLE_RATE,
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }
    )
    payload = {
        "meta": {
            "backend": "ark-asr",
            "model": workflow.model_name,
            "audio_filepath": str(audio_path),
            "duration": duration,
            "source_file": {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns},
            "num_segments": len(segments),
            "generation_params": params,
        },
        "segments": segments,
        "vad_segments": [
            {"start": first / SAMPLE_RATE, "end": last / SAMPLE_RATE} for first, last in chunks
        ],
    }
    atomic_write_json(output / hash_component / RAW_FILENAME, payload, indent=2, ensure_ascii=False)
    return payload


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args(argv)
    configured = select_transcription_workflow(
        "ark-asr", model_name=args.model, language=args.language
    )
    workflow = replace(
        configured,
        model_name=args.model or configured.model_name,
        language=resolve_language_setting(args.language, configured.language),
        vad_model=args.vad_model or configured.vad_model or "silero_vad_v6",
        align_model=args.align_model.strip()
        if args.align_model is not None
        else configured.align_model,
    )
    if workflow.vad_model != "silero_vad_v6":
        raise ValueError("ark-asr supports vad_model='silero_vad_v6'")
    validate_workflow_language(
        "ark-asr", workflow.language, workflow.align_model, context="this run:"
    )
    revision = model_revision(workflow.model_name, args.revision)
    output = resolve_bundle_root(args.output_dir, workflow)
    pending = []
    for source in args.audio:
        audio_path = source.expanduser().resolve(strict=True)
        target = output / require_valid_hash_stem(audio_path) / RAW_FILENAME
        if args.skip_existing and raw_is_complete(target, audio_path, workflow, revision):
            logging.info("Skipping complete ARK raw result: %s", target)
        else:
            pending.append(audio_path)
    if not pending:
        return 0
    runtime = load_model(workflow.model_name, args.device, revision)
    from silero_vad import load_silero_vad

    vad = load_silero_vad(onnx=True)
    for audio_path in pending:
        transcribe_file(audio_path, runtime=runtime, vad=vad, workflow=workflow, output=output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
