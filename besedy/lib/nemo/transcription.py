"""Model loading and transcription for NeMo.

This module handles:
- VAD and ASR model loading
- Audio loading and validation
- Segment transcription using NeMo models
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
from pathlib import Path

import soundfile as sf
import torch
from nemo.collections.asr.models import ASRModel, EncDecFrameClassificationModel
from nemo.collections.asr.models.aed_multitask_models import MultiTaskTranscriptionConfig
from tqdm.auto import tqdm

from besedy.config.settings import config
from besedy.core.paths import validate_mono_wav_16k
from besedy.lib.nemo.confidence import (
    SegmentResult,
    VadArtifacts,
    _coerce_float,
    _derive_segment_confidence,
    _flatten_confidence_values,
    _normalize_nested,
    configure_asr_confidence,
    configure_asr_decoding_strategy,
)
from besedy.lib.nemo.segments import strip_control_tokens

# ---------------------------------------------------------------------------
# Device resolution
# ---------------------------------------------------------------------------


def resolve_device(preference: str) -> torch.device:
    """Resolve device preference to a torch.device.

    Args:
        preference: One of 'cuda', 'cpu', or 'auto'.

    Returns:
        torch.device for the selected device.

    Raises:
        RuntimeError: If CUDA is requested but not available.
    """
    if preference == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but not available.")
        return torch.device("cuda")
    if preference == "cpu":
        return torch.device("cpu")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


# ---------------------------------------------------------------------------
# Audio loading
# ---------------------------------------------------------------------------


def load_audio(path: Path, target_sr: int) -> torch.Tensor:
    """Load audio file and validate format.

    Args:
        path: Path to audio file.
        target_sr: Expected sample rate (must match config.audio.sample_rate).

    Returns:
        1D torch.Tensor containing the audio waveform.

    Raises:
        ValueError: If target_sr doesn't match config.audio.sample_rate or
            audio format is invalid.
    """
    if target_sr != config.audio.sample_rate:
        raise ValueError(
            f"load_audio expects target_sr={config.audio.sample_rate}; received {target_sr}."
        )

    # Use soundfile directly to avoid torchcodec compatibility issues with PyTorch nightly
    data, sample_rate = sf.read(str(path), dtype="float32")
    waveform = torch.from_numpy(data)

    # Handle stereo -> mono if needed (though we expect mono)
    if waveform.ndim == 2:
        waveform = waveform.mean(dim=1)

    channel_count = 1 if waveform.ndim == 1 else int(waveform.size(0))
    validate_mono_wav_16k(path, sample_rate, channel_count)

    return waveform


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------


def _extract_cache_dir(exc: FileNotFoundError) -> Path | None:
    """Extract cache directory from FileNotFoundError for fallback loading.

    Args:
        exc: FileNotFoundError from model loading attempt.

    Returns:
        Parent directory of the missing file, or None if not extractable.
    """
    filename = getattr(exc, "filename", None)
    if filename:
        return Path(filename).parent
    match = re.search(r": '([^']+)'", str(exc))
    if match:
        return Path(match.group(1)).parent
    return None


def load_frame_vad(model_ref: str, device: torch.device) -> EncDecFrameClassificationModel:
    """Load a frame-level VAD model.

    Supports both local .nemo checkpoints and pretrained model names.
    Falls back to local .nemo files in cache if download fails.

    Args:
        model_ref: Path to .nemo file or pretrained model name.
        device: Device to load model onto.

    Returns:
        Loaded EncDecFrameClassificationModel on the specified device.
    """
    path = Path(model_ref)
    if path.suffix == ".nemo" and path.is_file():
        model = EncDecFrameClassificationModel.restore_from(restore_path=str(path), strict=False)
    else:
        try:
            model = EncDecFrameClassificationModel.from_pretrained(model_ref)
        except FileNotFoundError as exc:
            cache_dir = _extract_cache_dir(exc)
            if cache_dir and cache_dir.exists():
                nemo_candidates = list(cache_dir.glob("*.nemo"))
                if nemo_candidates:
                    logging.info("Falling back to local .nemo archive at %s", nemo_candidates[0])
                    model = EncDecFrameClassificationModel.restore_from(
                        restore_path=str(nemo_candidates[0]),
                        strict=False,
                    )
                else:
                    raise
            else:
                raise
    return model.to(device)


def load_asr(
    model_ref: str,
    device: torch.device,
    *,
    decode_strategy: str = "greedy",
    beam_size: int | None = None,
    softmax_temperature: float | None = None,
    beam_length_penalty: float | None = None,
    beam_max_generation_delta: int | None = None,
) -> ASRModel:
    """Load an ASR model with confidence extraction enabled.

    Supports both local .nemo checkpoints and pretrained model names.
    Configures the model for confidence preservation and enables
    Flash Attention if available.

    Args:
        model_ref: Path to .nemo file or pretrained model name.
        device: Device to load model onto.

    Returns:
        Loaded ASRModel on the specified device.
    """
    path = Path(model_ref)
    if path.suffix == ".nemo" and path.is_file():
        model = ASRModel.restore_from(restore_path=str(path), strict=False)
    else:
        model = ASRModel.from_pretrained(model_ref)
    if decode_strategy == "greedy":
        configure_asr_confidence(model)
    elif decode_strategy:
        configure_asr_decoding_strategy(
            model,
            decode_strategy,
            beam_size=beam_size,
            softmax_temperature=softmax_temperature,
            beam_length_penalty=beam_length_penalty,
            beam_max_generation_delta=beam_max_generation_delta,
            disable_confidence=True,
        )

    # Enable Flash Attention via SDPA if encoder supports it
    if hasattr(model, "encoder") and hasattr(model.encoder, "use_pytorch_sdpa"):
        model.encoder.use_pytorch_sdpa = True
        logging.info("Enabled PyTorch SDPA (Flash Attention) for encoder")

    return model.to(device)


def _normalize_word_entry(entry: object) -> dict[str, object]:
    """Coerce a word payload into a mutable mapping with string keys."""
    if isinstance(entry, dict):
        return {str(key): value for key, value in entry.items()}
    return {"word": str(entry)}


def _fully_defined_word_confidence(values: list[float | None]) -> list[float] | None:
    """Return confidence values only when every entry is present."""
    if not values:
        return None
    resolved: list[float] = []
    for value in values:
        if value is None:
            return None
        resolved.append(float(value))
    return resolved


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------


def transcribe_segments(
    waveform: torch.Tensor,
    asr_model: ASRModel,
    artifacts: VadArtifacts,
    frame_unit: float,
    batch_size: int,
    sample_rate: int,
    source_lang: str,
    target_lang: str,
) -> list[SegmentResult]:
    """Transcribe VAD segments using NeMo's model.transcribe().

    Segments are produced by the VAD layer; optional chunking may further split
    long segments upstream when enabled, so no additional chunking is done here.

    Args:
        waveform: Full audio waveform as 1D tensor.
        asr_model: Loaded ASR model.
        artifacts: VadArtifacts containing segments and chunks.
        frame_unit: Duration of each VAD frame in seconds.
        batch_size: Batch size (currently unused, always 1).
        sample_rate: Audio sample rate (must match config.audio.sample_rate).
        source_lang: Source language code for transcription.
        target_lang: Target language code for transcription.

    Returns:
        List of SegmentResult objects with transcription results.
    """
    segments = list(artifacts.segments)
    segments.sort(key=lambda item: item.get("start", 0.0))

    if not segments:
        total_duration = waveform.shape[-1] / sample_rate if waveform.numel() else 0.0
        frame_start_default = int(round(0.0 / frame_unit)) if frame_unit else None
        frame_end_default = int(round(total_duration / frame_unit)) if frame_unit else None
        return [
            SegmentResult(
                time_start=0.0,
                time_end=total_duration,
                text="",
                chunk_idx=None,
                frame_start=frame_start_default,
                frame_end=frame_end_default,
                timestamps=None,
                tokens=None,
                words=None,
                word_confidence=None,
                mean_probability=None,
            )
        ]

    asr_model.eval()
    results: list[SegmentResult] = []
    alias_to_chunk_idx: dict[str | None, int] = {
        chunk.alias: idx for idx, chunk in enumerate(artifacts.chunks)
    }
    if not alias_to_chunk_idx:
        alias_to_chunk_idx[None] = 0

    # Process each VAD segment with progress bar
    for segment in tqdm(
        segments, desc="Transcribing segments", unit="seg", position=1, leave=False, ncols=100
    ):
        start_time = float(segment.get("start", 0.0) or 0.0)
        end_time = float(segment.get("end", start_time) or start_time)
        duration = end_time - start_time
        chunk_alias = segment.get("chunk_alias")
        chunk_idx = alias_to_chunk_idx.get(chunk_alias)
        frame_start = int(round(start_time / frame_unit)) if frame_unit else None
        frame_end = int(round(end_time / frame_unit)) if frame_unit else None

        # Extract segment audio
        start_sample = int(start_time * sample_rate)
        end_sample = int(end_time * sample_rate)
        start_sample = max(0, min(start_sample, waveform.shape[-1]))
        end_sample = max(start_sample, min(end_sample, waveform.shape[-1]))

        segment_audio = waveform[start_sample:end_sample]

        min_segment_samples = max(1, int(sample_rate * 0.05))

        if segment_audio.numel() < min_segment_samples:
            logging.warning(
                "Segment %d (%.2fs-%.2fs) too short for featurizer (%d samples < %d required). Duration: %.4fs",
                segment.get("chunk_local_index", -1),
                start_time,
                end_time,
                duration,
                segment_audio.numel(),
                min_segment_samples,
            )
            results.append(
                SegmentResult(
                    time_start=start_time,
                    time_end=end_time,
                    text="",
                    chunk_idx=chunk_idx,
                    frame_start=frame_start,
                    frame_end=frame_end,
                    timestamps=None,
                    tokens=None,
                    words=None,
                    word_confidence=None,
                    mean_probability=_coerce_float(segment.get("mean_prob")),
                )
            )
            continue

        # Serialize segment audio to a temporary WAV for NeMo transcription
        segment_audio_np = segment_audio.cpu().numpy()
        tmp_wav_path = None
        tmp_handle = None
        try:
            tmp_handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp_wav_path = tmp_handle.name
            tmp_handle.close()
            sf.write(tmp_wav_path, segment_audio_np, sample_rate)
        except Exception:
            if tmp_handle is not None:
                tmp_handle.close()
            if tmp_wav_path and os.path.exists(tmp_wav_path):
                os.unlink(tmp_wav_path)
            raise

        # VAD layer already enforces max_segment_length, so chunking is disabled
        if duration > 30.0:
            logging.warning(
                "Segment %.2fs-%.2fs has duration %.2fs > 30s, which should have been prevented by VAD layer",
                start_time,
                end_time,
                duration,
            )

        transcription_config = MultiTaskTranscriptionConfig(
            batch_size=1,
            return_hypotheses=True,
            enable_chunking=False,
            verbose=False,
            timestamps=True,
            prompt={
                "source_lang": source_lang,
                "target_lang": target_lang,
                "timestamp": "yes",
            },
        )
        try:
            transcription_result = asr_model.transcribe(
                audio=[tmp_wav_path],
                timestamps=True,
                override_config=transcription_config,
            )
        finally:
            if tmp_wav_path and os.path.exists(tmp_wav_path):
                os.unlink(tmp_wav_path)

        # Extract the single Hypothesis from the result list
        hypothesis = transcription_result[0]

        # Extract metadata from Hypothesis object
        text = hypothesis.text.strip() if hypothesis.text else ""
        text = strip_control_tokens(text)

        # Extract optional metadata fields
        raw_timestamp = getattr(hypothesis, "timestamp", None)
        if logging.getLogger().isEnabledFor(logging.DEBUG):
            logging.debug(
                "Hypothesis timestamp payload type=%s keys=%s",
                type(raw_timestamp),
                list(raw_timestamp.keys()) if isinstance(raw_timestamp, dict) else None,
            )
        timestamps = _normalize_nested(raw_timestamp)
        tokens = _normalize_nested(getattr(hypothesis, "tokens", None))

        words = None
        if isinstance(timestamps, dict):
            for key in ("word", "words"):
                entries = timestamps.get(key)
                if entries:
                    words = _normalize_nested(entries)
                    break

        word_confidence = None
        if hasattr(hypothesis, "word_confidence") and hypothesis.word_confidence:
            word_confidence = _flatten_confidence_values(hypothesis.word_confidence)
            if not word_confidence:
                word_confidence = None
        if isinstance(words, list):
            normalized_words: list[dict[str, object]] = []
            for idx, entry in enumerate(words):
                normalized_entry = _normalize_word_entry(entry)
                if "index" not in normalized_entry:
                    normalized_entry["index"] = idx
                if (
                    word_confidence
                    and idx < len(word_confidence)
                    and normalized_entry.get("confidence") is None
                ):
                    normalized_entry["confidence"] = word_confidence[idx]
                normalized_words.append(normalized_entry)
            words = normalized_words
            if word_confidence is None:
                extracted: list[float | None] = [
                    _coerce_float(item.get("confidence")) for item in normalized_words
                ]
                word_confidence = _fully_defined_word_confidence(extracted)
        if not words and word_confidence:
            raw_words = getattr(hypothesis, "words", None)
            if raw_words:
                normalized_words = list(raw_words)
                word_count = min(len(normalized_words), len(word_confidence))
                words = [
                    {
                        "word": normalized_words[idx],
                        "confidence": word_confidence[idx],
                        "index": idx,
                    }
                    for idx in range(word_count)
                ]
                if word_count < len(normalized_words):
                    for idx in range(word_count, len(normalized_words)):
                        words.append({"word": normalized_words[idx], "index": idx})

        mean_probability = _derive_segment_confidence(hypothesis)
        vad_mean_probability = _coerce_float(
            segment.get("mean_probability", segment.get("mean_prob"))
        )
        if mean_probability is None:
            mean_probability = vad_mean_probability
        logging.debug(
            "Segment conf details: hypo=%s vad=%s final=%s text_preview=%s",
            _coerce_float(getattr(hypothesis, "confidence", None)),
            vad_mean_probability,
            mean_probability,
            text[:60] if text else "",
        )

        results.append(
            SegmentResult(
                time_start=start_time,
                time_end=end_time,
                text=text,
                chunk_idx=chunk_idx,
                frame_start=frame_start,
                frame_end=frame_end,
                timestamps=timestamps,
                tokens=tokens,
                words=words,
                word_confidence=word_confidence,
                mean_probability=mean_probability,
            )
        )

    return results
