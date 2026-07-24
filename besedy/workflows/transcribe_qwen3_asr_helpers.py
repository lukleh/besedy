"""Helper stack for the Qwen3-ASR workflow."""

from __future__ import annotations

import logging
from typing import Any, Protocol

import numpy as np
import torch
from tqdm.auto import tqdm

QWEN3_ASR_MIN_WAVEFORM_SAMPLES_DEFAULT = 201


class VadModel(Protocol):
    def __call__(self, waveform: torch.Tensor, /, *args: Any, **kwargs: Any) -> Any: ...


class _FeatureExtractorLike(Protocol):
    n_fft: object


class _TokenizerLike(Protocol):
    pad_token_id: object
    eos_token_id: object


class _ProcessorLike(Protocol):
    feature_extractor: _FeatureExtractorLike | None
    tokenizer: _TokenizerLike | None
    pad_token_id: object
    eos_token_id: object


class _GenerationModuleLike(Protocol):
    generation_config: object | None
    config: object | None
    thinker: object | None
    talker: object | None


class AsrModelLike(Protocol):
    processor: _ProcessorLike | None
    tokenizer: _TokenizerLike | None
    model: _GenerationModuleLike | None


def extract_vad_segments(
    audio: np.ndarray,
    *,
    vad_model: VadModel,
    min_silence_duration_ms: int | None,
    min_speech_duration_ms: int | None,
    speech_threshold: float | None,
    sample_rate: int,
) -> list[dict[str, float]]:
    from silero_vad import get_speech_timestamps

    vad_kwargs: dict[str, Any] = {
        "sampling_rate": sample_rate,
    }
    if min_silence_duration_ms is not None:
        vad_kwargs["min_silence_duration_ms"] = int(min_silence_duration_ms)
    if min_speech_duration_ms is not None:
        vad_kwargs["min_speech_duration_ms"] = int(min_speech_duration_ms)
    if speech_threshold is not None:
        vad_kwargs["threshold"] = float(speech_threshold)

    waveform = torch.as_tensor(audio, dtype=torch.float32)
    speech_chunks = get_speech_timestamps(waveform, vad_model, **vad_kwargs)

    return [
        {
            "start": round(float(chunk["start"]) / sample_rate, 6),
            "end": round(float(chunk["end"]) / sample_rate, 6),
        }
        for chunk in speech_chunks
    ]


def _interpolated_words(text: str, start: float, end: float) -> list[dict[str, Any]]:
    tokens = [token for token in text.split() if token]
    if not tokens:
        return []

    duration = max(0.0, end - start)
    step = duration / len(tokens) if duration > 0 else 0.0

    words: list[dict[str, Any]] = []
    for idx, token in enumerate(tokens):
        w_start = start + (idx * step)
        w_end = end if idx == len(tokens) - 1 else start + ((idx + 1) * step)
        w_start = round(max(start, min(end, w_start)), 6)
        w_end = round(max(w_start, min(end, w_end)), 6)
        words.append(
            {
                "start": w_start,
                "end": w_end,
                "word": token,
                "confidence": None,
            }
        )
    return words


def _resolve_segmenter_mode(
    *,
    requested: str,
    request_timestamps: bool,
    vad_filter_enabled: bool,
) -> str:
    _ = request_timestamps
    _ = vad_filter_enabled
    if requested != "auto":
        return requested
    return "silero-vad"


def _split_segments_by_max_duration(
    segments: list[dict[str, float]],
    *,
    max_segment_seconds: float,
) -> list[dict[str, float]]:
    limit = max(1.0, float(max_segment_seconds))
    split: list[dict[str, float]] = []

    for segment in segments:
        start = float(segment["start"])
        end = float(segment["end"])
        if end <= start:
            continue

        cursor = start
        while cursor < end:
            next_end = min(end, cursor + limit)
            split.append(
                {
                    "start": round(cursor, 6),
                    "end": round(next_end, 6),
                }
            )
            if next_end <= cursor:
                break
            cursor = next_end

    return split


def _resolve_min_waveform_samples(asr_model: AsrModelLike) -> int:
    """Infer the minimum waveform length needed by the model feature extractor."""

    processor = getattr(asr_model, "processor", None)
    feature_extractor = getattr(processor, "feature_extractor", None)
    n_fft = getattr(feature_extractor, "n_fft", None)
    if n_fft is None:
        return QWEN3_ASR_MIN_WAVEFORM_SAMPLES_DEFAULT
    try:
        n_fft_value = int(n_fft)
    except (TypeError, ValueError):
        return QWEN3_ASR_MIN_WAVEFORM_SAMPLES_DEFAULT

    if n_fft_value <= 0:
        return QWEN3_ASR_MIN_WAVEFORM_SAMPLES_DEFAULT

    return max(1, (n_fft_value // 2) + 1)


def _should_drop_short_decode_segment(*, num_samples: int, min_samples: int) -> bool:
    required_samples = max(1, int(min_samples))
    return int(num_samples) < required_samples


def _iter_alignment_items(alignment: Any) -> list[Any]:
    if alignment is None:
        return []
    if hasattr(alignment, "items"):
        items = getattr(alignment, "items")
        try:
            return list(items)
        except TypeError:
            return []
    if isinstance(alignment, list):
        return alignment
    try:
        return list(alignment)
    except TypeError:
        return []


def _word_items_from_alignment(
    *,
    alignment: Any,
    segment_start: float,
    segment_end: float,
) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    alignment_items = _iter_alignment_items(alignment)
    if not alignment_items:
        return words

    for item in alignment_items:
        token = str(getattr(item, "text", "") or "").strip()
        if not token:
            continue

        rel_start = float(getattr(item, "start_time", 0.0))
        rel_end = float(getattr(item, "end_time", rel_start))

        w_start = segment_start + rel_start
        w_end = segment_start + rel_end
        if w_end < w_start:
            w_end = w_start
        w_start = round(max(segment_start, min(segment_end, w_start)), 6)
        w_end = round(max(w_start, min(segment_end, w_end)), 6)

        words.append(
            {
                "start": w_start,
                "end": w_end,
                "word": token,
                "confidence": None,
            }
        )

    return words


def _render_segment_text(tokens: list[str]) -> str:
    no_space_before = {".", ",", "!", "?", ";", ":", ")", "]", "}", "%", "…"}
    no_space_after = {"(", "[", "{", "¿", "¡", "„", "«"}

    parts: list[str] = []
    for token in tokens:
        t = token.strip()
        if not t:
            continue
        if not parts:
            parts.append(t)
            continue
        prev = parts[-1]
        if t in no_space_before or prev in no_space_after:
            parts[-1] = f"{prev}{t}"
        else:
            parts.append(t)
    return " ".join(parts).strip()


def _build_segments_from_words(
    words: list[dict[str, Any]],
    *,
    max_gap_s: float,
    max_duration_s: float,
) -> list[dict[str, Any]]:
    if not words:
        return []

    sorted_words = sorted(
        words,
        key=lambda item: (float(item["start"]), float(item["end"])),
    )

    max_gap_s = max(0.0, float(max_gap_s))
    max_duration_s = max(1.0, float(max_duration_s))

    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    group_start: float | None = None
    prev_end: float | None = None

    for word in sorted_words:
        start = float(word["start"])
        end = float(word["end"])

        if current and group_start is not None and prev_end is not None:
            gap = max(0.0, start - prev_end)
            would_duration = max(0.0, end - group_start)
            if gap > max_gap_s or would_duration > max_duration_s:
                groups.append(current)
                current = []
                group_start = None
                prev_end = None

        if not current:
            group_start = start
        current.append(word)
        prev_end = end

    if current:
        groups.append(current)

    segments: list[dict[str, Any]] = []
    for group in groups:
        text = _render_segment_text([str(item["word"]) for item in group])
        start = round(float(group[0]["start"]), 6)
        end = round(float(group[-1]["end"]), 6)
        segments.append(
            {
                "start": start,
                "end": end,
                "text": text,
                "confidence": None,
                "words": group,
            }
        )
    return segments


def _build_sanitized_generation_config(model_name: str) -> Any | None:
    """Build a model-derived generation config with greedy-safe defaults."""

    try:
        from transformers import AutoConfig, GenerationConfig
    except ImportError:
        return None

    try:
        model_config = AutoConfig.from_pretrained(model_name)
        generation_config = GenerationConfig.from_model_config(model_config)
    except Exception as exc:
        logging.debug(
            "Could not pre-load generation config for %s; using model defaults: %s",
            model_name,
            exc,
        )
        return None

    if getattr(generation_config, "do_sample", None) is False:
        if getattr(generation_config, "temperature", None) is not None:
            generation_config.temperature = None

    return generation_config


def _build_qwen_model(
    *,
    model_name: str,
    device: str,
    dtype: str,
    batch_size: int,
    max_new_tokens: int,
    align_model: str | None,
) -> Any:
    try:
        import torch
        from qwen_asr import Qwen3ASRModel
    except ImportError as exc:
        raise RuntimeError(
            "qwen-asr is not installed in this environment. "
            "Use the Besedy Docker qwen3-asr worker or build the qwen3-asr backend image."
        ) from exc

    dtype_map = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": torch.float32,
    }
    if dtype not in dtype_map:
        raise ValueError(f"Unsupported dtype: {dtype}")

    generation_config = _build_sanitized_generation_config(model_name)

    kwargs: dict[str, Any] = {
        "dtype": dtype_map[dtype],
        "device_map": device,
        "max_inference_batch_size": max(1, int(batch_size)),
        "max_new_tokens": max(1, int(max_new_tokens)),
    }
    if generation_config is not None:
        kwargs["generation_config"] = generation_config
    if align_model:
        kwargs["forced_aligner"] = align_model
        kwargs["forced_aligner_kwargs"] = {
            "dtype": dtype_map[dtype],
            "device_map": device,
        }

    return Qwen3ASRModel.from_pretrained(model_name, **kwargs)


def _configure_generation_padding(asr_model: AsrModelLike) -> None:
    """Set generation defaults for model and nested generators to reduce HF warnings."""

    def _token_id(value: Any) -> int | None:
        if isinstance(value, list):
            value = value[0] if value else None
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _infer_fallback_pad_token_id(wrapper: Any) -> int | None:
        processor = getattr(wrapper, "processor", None)
        tokenizer = getattr(processor, "tokenizer", None)
        wrapper_tokenizer = getattr(wrapper, "tokenizer", None)

        candidates = [
            getattr(tokenizer, "pad_token_id", None),
            getattr(processor, "pad_token_id", None),
            getattr(wrapper_tokenizer, "pad_token_id", None),
            getattr(tokenizer, "eos_token_id", None),
            getattr(processor, "eos_token_id", None),
            getattr(wrapper_tokenizer, "eos_token_id", None),
        ]
        for candidate in candidates:
            token = _token_id(candidate)
            if token is not None:
                return token
        return None

    def _set_for_module(module: Any, *, fallback_pad_token_id: int | None) -> bool:
        generation_config = getattr(module, "generation_config", None)
        model_config = getattr(module, "config", None)
        if generation_config is None:
            return False

        if getattr(generation_config, "do_sample", None) is False:
            if getattr(generation_config, "temperature", None) is not None:
                generation_config.temperature = None

        existing_pad = _token_id(getattr(generation_config, "pad_token_id", None))
        if existing_pad is not None:
            return True
        existing_pad = _token_id(getattr(model_config, "pad_token_id", None))
        if existing_pad is not None:
            generation_config.pad_token_id = existing_pad
            return True

        eos_token_id = _token_id(getattr(generation_config, "eos_token_id", None))
        if eos_token_id is None:
            eos_token_id = _token_id(getattr(model_config, "eos_token_id", None))

        pad_token_id = eos_token_id if eos_token_id is not None else fallback_pad_token_id
        if pad_token_id is None:
            return False

        generation_config.pad_token_id = int(pad_token_id)
        if (
            model_config is not None
            and _token_id(getattr(model_config, "pad_token_id", None)) is None
        ):
            model_config.pad_token_id = int(pad_token_id)
        return True

    model = getattr(asr_model, "model", None)
    if model is None:
        return

    modules = [model, getattr(model, "thinker", None), getattr(model, "talker", None)]
    fallback_pad_token_id = _infer_fallback_pad_token_id(asr_model)
    configured_any = False
    for module in modules:
        if module is None:
            continue
        if _set_for_module(module, fallback_pad_token_id=fallback_pad_token_id):
            configured_any = True
    if not configured_any:
        logging.warning(
            "Qwen3-ASR generation pad_token_id could not be inferred; "
            "Transformers may emit repeated pad_token warnings."
        )


def _is_cuda_oom(exc: BaseException | None) -> bool:
    current = exc
    hops = 0
    while current is not None and hops < 6:
        msg = str(current).lower()
        cls_name = type(current).__name__.lower()
        if "cuda out of memory" in msg or "outofmemory" in cls_name:
            return True
        current = current.__cause__ or current.__context__
        hops += 1
    return False


def _clear_cuda_cache() -> None:
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _log_segment_preview(audio_name: str, start: float, end: float, text: str) -> None:
    snippet = " ".join((text or "").split())
    if len(snippet) > 180:
        snippet = f"{snippet[:177]}..."
    tqdm.write(f"[{audio_name}] {start:.2f}-{end:.2f}s {snippet}")
