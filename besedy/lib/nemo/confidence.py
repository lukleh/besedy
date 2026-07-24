"""Confidence extraction and data classes for NeMo transcription.

This module handles:
- Data classes for segment results, VAD chunks, and artifacts
- Confidence score extraction from NeMo Hypothesis objects
- Normalization of nested tensor/array structures
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import torch
from omegaconf import OmegaConf

from besedy.lib.nemo.segments import CONTROL_TOKEN_PATTERN

# Re-export for backwards compatibility
try:
    from nemo.collections.asr.models import ASRModel
except ImportError:
    ASRModel = None  # type: ignore[misc, assignment]


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------


def _coerce_float(value: Any) -> float | None:
    """Safely convert a value to float, returning None on failure or NaN.

    Args:
        value: Any value to convert.

    Returns:
        Float value, or None if conversion fails or result is NaN.
    """
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(result):
        return None
    return result


def _flatten_confidence_values(values: Any) -> list[float]:
    """Normalize nested tensor/list confidence values into a flat float list.

    Handles torch.Tensor, np.ndarray, dicts, lists, tuples, sets, and scalars.
    Filters out NaN values and non-numeric types.

    Args:
        values: Nested structure containing confidence values.

    Returns:
        Flat list of valid float values.
    """
    if values is None:
        return []
    if isinstance(values, torch.Tensor):
        if values.numel() == 0:
            return []
        values = values.detach().cpu().tolist()
    elif isinstance(values, np.ndarray):
        if values.size == 0:
            return []
        values = values.tolist()
    elif isinstance(values, dict):
        flattened: list[float] = []
        for item in values.values():
            flattened.extend(_flatten_confidence_values(item))
        return flattened

    if isinstance(values, (str, bytes)):
        return []

    if isinstance(values, (list, tuple, set)):
        flattened = []
        for item in values:
            flattened.extend(_flatten_confidence_values(item))
        return flattened

    try:
        val = float(values)
    except (TypeError, ValueError):
        return []
    if math.isnan(val):
        return []
    return [val]


def _normalize_nested(payload: Any) -> Any:
    """Convert tensors/arrays within timestamp or token structures into Python lists.

    Recursively processes dicts, lists, tuples, and sets, converting any
    torch.Tensor or np.ndarray to native Python types.

    Args:
        payload: Nested structure potentially containing tensors.

    Returns:
        Same structure with tensors converted to lists.
    """
    if payload is None:
        return None
    if isinstance(payload, torch.Tensor):
        if payload.numel() == 0:
            return []
        return payload.detach().cpu().tolist()
    if isinstance(payload, np.ndarray):
        return payload.tolist()
    if isinstance(payload, dict):
        return {key: _normalize_nested(value) for key, value in payload.items()}
    if isinstance(payload, (list, tuple, set)):
        return [_normalize_nested(item) for item in payload]
    return payload


def _extract_timestamp_confidences(timestamp: Any) -> list[float]:
    """Harvest confidence-like numbers from NeMo timestamp dictionaries.

    Searches for confidence values under various keys used by NeMo:
    word, words, segment, segments, token, tokens, and nested timestamps.

    Args:
        timestamp: Dictionary from NeMo Hypothesis.timestamp attribute.

    Returns:
        List of extracted confidence values.
    """
    if not isinstance(timestamp, dict):
        return []

    collected: list[float] = []
    for key in ("word", "words", "segment", "segments", "token", "tokens"):
        entries = timestamp.get(key)
        if not entries:
            continue
        if isinstance(entries, dict):
            iterable = entries.values()
        else:
            iterable = entries
        for entry in iterable:
            if not isinstance(entry, dict):
                continue
            for attr in ("confidence", "probability", "prob", "p", "score"):
                if attr in entry:
                    collected.extend(_flatten_confidence_values(entry[attr]))
    nested = timestamp.get("timestamps")
    if nested:
        collected.extend(_flatten_confidence_values(nested))
    return collected


def _derive_segment_confidence(hypothesis: Any) -> float | None:
    """Compute an aggregate confidence score from a NeMo Hypothesis.

    Tries multiple sources in order of preference:
    1. Direct confidence attribute
    2. Word confidence (mean)
    3. Token confidence (mean)
    4. Frame confidence (mean)
    5. Timestamp-embedded confidence values (mean)

    Args:
        hypothesis: NeMo Hypothesis object from transcription.

    Returns:
        Aggregate confidence score, or None if unavailable.
    """
    if hypothesis is None:
        return None

    scalar_conf = _flatten_confidence_values(getattr(hypothesis, "confidence", None))
    if scalar_conf:
        return scalar_conf[0]

    candidate_sequences: list[list[float]] = []

    word_conf = _flatten_confidence_values(getattr(hypothesis, "word_confidence", None))
    if word_conf:
        candidate_sequences.append(word_conf)

    token_conf = _flatten_confidence_values(getattr(hypothesis, "token_confidence", None))
    if token_conf:
        candidate_sequences.append(token_conf)

    try:
        non_blank_frame_conf = _flatten_confidence_values(
            getattr(hypothesis, "non_blank_frame_confidence", None)
        )
    except (KeyError, AttributeError, TypeError):
        non_blank_frame_conf = []
    if non_blank_frame_conf:
        candidate_sequences.append(non_blank_frame_conf)
    else:
        try:
            frame_conf = _flatten_confidence_values(getattr(hypothesis, "frame_confidence", None))
        except (KeyError, AttributeError, TypeError):
            frame_conf = []
        if frame_conf:
            candidate_sequences.append(frame_conf)

    timestamp_conf = _extract_timestamp_confidences(getattr(hypothesis, "timestamp", None))
    if timestamp_conf:
        candidate_sequences.append(timestamp_conf)

    for sequence in candidate_sequences:
        if not sequence:
            continue
        mean_val = sum(sequence) / len(sequence)
        if not math.isnan(mean_val):
            return float(mean_val)

    return None


def configure_asr_confidence(model: Any) -> None:
    """Enable word/token confidence preservation on the ASR decoder.

    Modifies the model's decoding configuration to:
    - Use greedy strategy
    - Preserve word, token, and frame confidence
    - Use mean aggregation with max_prob method

    Args:
        model: NeMo ASRModel instance.
    """
    try:
        decoding_cfg = model.cfg.decoding
    except AttributeError:
        return

    try:
        decoding_dict = OmegaConf.to_container(decoding_cfg, resolve=True)
    except Exception:  # pragma: no cover - defensive
        return

    if not isinstance(decoding_dict, dict):
        return

    confidence_cfg = dict(decoding_dict.get("confidence_cfg") or {})
    updated = False

    if decoding_dict.get("strategy") != "greedy":
        decoding_dict["strategy"] = "greedy"
        updated = True

    for key, desired in (
        ("preserve_word_confidence", True),
        ("preserve_token_confidence", True),
        ("preserve_frame_confidence", True),
    ):
        if confidence_cfg.get(key) != desired:
            confidence_cfg[key] = desired
            updated = True

    if confidence_cfg.get("aggregation") is None:
        confidence_cfg["aggregation"] = "mean"
        updated = True

    method_cfg = confidence_cfg.get("method_cfg")
    if not isinstance(method_cfg, dict):
        confidence_cfg["method_cfg"] = {"name": "max_prob"}
        updated = True
    elif method_cfg.get("name") is None:
        method_cfg["name"] = "max_prob"
        updated = True

    if not updated and "confidence_cfg" in decoding_dict:
        return

    decoding_dict["confidence_cfg"] = confidence_cfg
    new_cfg = OmegaConf.create(decoding_dict)
    model.change_decoding_strategy(decoding_cfg=new_cfg)


def configure_asr_decoding_strategy(
    model: Any,
    strategy: str | None,
    *,
    beam_size: int | None = None,
    softmax_temperature: float | None = None,
    beam_length_penalty: float | None = None,
    beam_max_generation_delta: int | None = None,
    disable_confidence: bool = False,
) -> None:
    """Configure NeMo ASR decoding strategy (greedy/beam) with optional params."""
    if not strategy:
        return
    try:
        decoding_cfg = model.cfg.decoding
    except AttributeError:
        return

    try:
        decoding_dict = OmegaConf.to_container(decoding_cfg, resolve=True)
    except Exception:  # pragma: no cover - defensive
        return

    if not isinstance(decoding_dict, dict):
        return

    decoding_dict["strategy"] = strategy
    if strategy == "beam":
        beam_cfg = dict(decoding_dict.get("beam") or {})
        if beam_size is not None:
            beam_cfg["beam_size"] = int(beam_size)
        if beam_length_penalty is not None:
            beam_cfg["len_pen"] = float(beam_length_penalty)
        if beam_max_generation_delta is not None:
            beam_cfg["max_generation_delta"] = int(beam_max_generation_delta)
        if beam_cfg:
            decoding_dict["beam"] = beam_cfg
        if softmax_temperature is not None:
            if "softmax_temperature" in decoding_dict:
                decoding_dict["softmax_temperature"] = float(softmax_temperature)
            elif "softmax_temperature" in beam_cfg:
                beam_cfg["softmax_temperature"] = float(softmax_temperature)
                decoding_dict["beam"] = beam_cfg
        if disable_confidence:
            confidence_cfg = dict(decoding_dict.get("confidence_cfg") or {})
            for key in (
                "preserve_word_confidence",
                "preserve_token_confidence",
                "preserve_frame_confidence",
            ):
                confidence_cfg[key] = False
            decoding_dict["confidence_cfg"] = confidence_cfg

    new_cfg = OmegaConf.create(decoding_dict)
    model.change_decoding_strategy(decoding_cfg=new_cfg)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class SegmentResult:
    """Result of transcribing a single VAD segment.

    Attributes:
        time_start: Segment start time (seconds).
        time_end: Segment end time (seconds).
        text: Transcribed text (control tokens stripped).
        chunk_idx: Index of the parent VAD chunk, if applicable.
        frame_start: Start frame index in VAD predictions.
        frame_end: End frame index in VAD predictions.
        timestamps: Raw timestamp data from NeMo (normalized).
        tokens: Raw token data from NeMo (normalized).
        words: List of word dictionaries with timing and confidence.
        word_confidence: List of per-word confidence scores.
        mean_probability: Aggregate confidence for the segment.
    """

    time_start: float
    time_end: float
    text: str
    chunk_idx: int | None = None
    frame_start: int | None = None
    frame_end: int | None = None
    timestamps: list | None = None
    tokens: list | None = None
    words: list | None = None
    word_confidence: list[float] | None = None
    mean_probability: float | None = None

    def to_dict(self, previous_end: float | None = None) -> dict:
        """Return the segment encoded in the canonical transcript schema.

        Args:
            previous_end: End time of previous segment, used to enforce
                monotonic timestamps.

        Returns:
            Dictionary with start, end, text, confidence, and words keys.
        """
        start = _coerce_float(self.time_start)
        end = _coerce_float(self.time_end)
        if start is None:
            start = 0.0
        if end is None or end < start:
            end = start

        if previous_end is not None and start < previous_end:
            start = previous_end
            if end < start:
                end = start

        confidence = _coerce_float(self.mean_probability)

        words = self._canonical_words(start, end)

        return {
            "start": round(start, 6),
            "end": round(end, 6),
            "text": self.text or "",
            "confidence": confidence,
            "words": words,
        }

    def _canonical_words(self, segment_start: float, segment_end: float) -> list[dict]:
        """Convert NeMo word metadata to canonical word dictionaries.

        Handles timing adjustments, monotonicity enforcement, and confidence
        propagation from word_confidence list.

        Args:
            segment_start: Segment start time for offset calculation.
            segment_end: Segment end time for clamping.

        Returns:
            List of word dictionaries with start, end, word, confidence keys.
        """
        canonical_words: list[dict] = []
        if not self.words:
            return canonical_words

        confidences = self.word_confidence if isinstance(self.word_confidence, list) else []
        prev_end = segment_start

        for idx, item in enumerate(self.words):
            if not isinstance(item, dict):
                continue

            word_text = str(item.get("word") or item.get("text") or "").strip()
            if CONTROL_TOKEN_PATTERN.search(word_text):
                continue
            if not word_text:
                continue

            rel_start = _coerce_float(item.get("start"))
            if rel_start is None:
                rel_start = _coerce_float(item.get("start_time"))
            rel_end = _coerce_float(item.get("end"))
            if rel_end is None:
                rel_end = _coerce_float(item.get("end_time"))

            if rel_start is None and rel_end is None:
                # Insufficient timing metadata; skip this word.
                continue

            if rel_start is None:
                rel_start = rel_end
            if rel_end is None:
                rel_end = rel_start
            assert rel_start is not None
            assert rel_end is not None

            word_start = segment_start + float(rel_start)
            word_end = segment_start + float(rel_end)

            if word_end < word_start:
                word_end = word_start

            # Clamp to segment bounds and ensure monotonic ordering.
            word_start = max(segment_start, word_start)
            if word_start > segment_end:
                word_start = segment_end
            word_end = min(segment_end, max(word_end, word_start))
            if word_start < prev_end:
                word_start = prev_end
                word_end = max(word_end, word_start)
            if word_end < word_start:
                word_end = word_start

            confidence = _coerce_float(item.get("confidence"))
            if confidence is None and confidences and idx < len(confidences):
                confidence = _coerce_float(confidences[idx])

            canonical_words.append(
                {
                    "start": round(word_start, 6),
                    "end": round(word_end, 6),
                    "word": word_text,
                    "confidence": confidence,
                }
            )
            prev_end = max(prev_end, word_end)

        return canonical_words


@dataclass
class VadChunk:
    """A VAD-detected speech chunk within an audio file.

    Attributes:
        alias: Unique identifier for this chunk.
        audio_path: Path to the source audio file.
        offset: Start time (seconds) of this chunk in the full audio.
        duration: Duration (seconds) of this chunk.
        segments: List of VAD segments within this chunk (local times).
        rttm_path: Path to RTTM file for this chunk, if available.
    """

    alias: str
    audio_path: Path
    offset: float
    duration: float | None
    segments: list[dict]
    rttm_path: Path | None = None


@dataclass
class VadArtifacts:
    """Collection of VAD outputs for a single audio file.

    Attributes:
        segments: List of VAD segments with absolute timestamps.
        chunks: List of VadChunk objects representing split audio regions.
    """

    segments: list[dict] = field(default_factory=list)
    chunks: list[VadChunk] = field(default_factory=list)
