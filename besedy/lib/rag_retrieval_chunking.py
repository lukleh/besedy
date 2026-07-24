"""Chunking/text helpers for transcript-only RAG retrieval."""

from __future__ import annotations

import hashlib
import re
from functools import lru_cache
from pathlib import Path
from statistics import fmean, median
from typing import Any, Protocol

from .rag_retrieval_types import ChunkTokenDistribution, ChunkWindow, SegmentUnit

TOKEN_RE = re.compile(r"\w+", re.UNICODE)
SHA256_64_RE = re.compile(r"^[a-f0-9]{64}$")

CHUNK_VERSION = "v2"
CHUNK_TOKENIZER_MODEL = "Alibaba-NLP/gte-multilingual-reranker-base"
CHUNK_MAX_SEGMENT_TOKENS = 90
CHUNK_SEGMENT_SPLIT_STRATEGY = "punctuation-then-words"

_SEGMENT_SPLIT_PATTERNS = (
    re.compile(r"(?<=[.!?;:])\s+"),
    re.compile(r"(?<=,)\s+"),
    re.compile(r"\s+[–—-]\s+"),
)


class TokenCounter(Protocol):
    """Counts document tokens for chunk sizing."""

    @property
    def model_name(self) -> str: ...

    def count_text(self, text: str) -> int: ...

    def count_texts(self, texts: list[str]) -> list[int]: ...


@lru_cache(maxsize=4)
def _load_chunk_tokenizer(model_name: str):
    try:
        from transformers import AutoTokenizer
    except ImportError as exc:
        raise ImportError(
            "transformers is required for tokenizer-aware chunk sizing. "
            "Install dependencies with `uv sync`."
        ) from exc

    return AutoTokenizer.from_pretrained(model_name, use_fast=True)


@lru_cache(maxsize=50000)
def _count_text_tokens_cached(model_name: str, text: str) -> int:
    tokenizer = _load_chunk_tokenizer(model_name)
    encoded = tokenizer(
        text,
        add_special_tokens=False,
        return_attention_mask=False,
        return_token_type_ids=False,
    )
    input_ids = encoded.get("input_ids", [])
    return max(len(input_ids), 1)


class HuggingFaceTokenCounter:
    """Tokenizer-backed token counter for chunk sizing."""

    def __init__(self, model_name: str = CHUNK_TOKENIZER_MODEL) -> None:
        self._model_name = model_name

    @property
    def model_name(self) -> str:
        return self._model_name

    def count_text(self, text: str) -> int:
        return _count_text_tokens_cached(self._model_name, text)

    def count_texts(self, texts: list[str]) -> list[int]:
        if not texts:
            return []

        tokenizer = _load_chunk_tokenizer(self._model_name)
        encoded = tokenizer(
            texts,
            add_special_tokens=False,
            padding=False,
            truncation=False,
            return_attention_mask=False,
            return_token_type_ids=False,
        )
        input_ids = encoded.get("input_ids", [])
        return [max(len(ids), 1) for ids in input_ids]


@lru_cache(maxsize=2)
def get_chunk_token_counter(model_name: str = CHUNK_TOKENIZER_MODEL) -> TokenCounter:
    """Return the canonical tokenizer-backed counter for chunk sizing."""

    return HuggingFaceTokenCounter(model_name=model_name)


def normalize_backend_key(value: str) -> str:
    """Normalize backend key to '{workflow}/{model_component}'."""

    candidate = value.strip()
    parts = candidate.split("/")
    if len(parts) == 2:
        workflow, model_component = parts
        if workflow and model_component:
            return candidate
    if len(parts) == 3:
        workflow, model, vad = parts
        if workflow and model and vad:
            return f"{workflow}/{model}@{vad}"
    raise ValueError(
        "Backend key must be '{workflow}/{model_component}' "
        "or '{workflow}/{model}/{vad}' (normalized to model@vad). "
        f"Got: {value!r}"
    )


def _tokenize(text: str) -> list[str]:
    return [tok.lower() for tok in TOKEN_RE.findall(text)]


def _is_full_sha256(value: str) -> bool:
    return bool(SHA256_64_RE.match(value.lower()))


def _infer_audio_hash(hash_component: str, transcript: dict[str, Any]) -> str | None:
    """Infer canonical 64-char audio hash from path/meta fields."""

    lowered = hash_component.lower()
    if _is_full_sha256(lowered):
        return lowered

    meta = transcript.get("meta")
    if isinstance(meta, dict):
        for key in ("audio_hash", "hash", "sha256"):
            value = meta.get(key)
            if isinstance(value, str) and _is_full_sha256(value):
                return value.lower()

        audio_path = meta.get("audio_filepath")
        if isinstance(audio_path, str):
            stem = Path(audio_path).stem.lower()
            if _is_full_sha256(stem):
                return stem

    return None


def _segments_from_transcript(
    transcript: dict[str, Any],
    *,
    token_counter: TokenCounter,
) -> list[SegmentUnit]:
    raw_segments = transcript.get("segments")
    if not isinstance(raw_segments, list):
        return []

    prepared_segments: list[tuple[float, float, str]] = []
    texts: list[str] = []
    for raw in raw_segments:
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text", "")).strip()
        if not text:
            continue
        try:
            start = float(raw.get("start", 0.0))
            end = float(raw.get("end", start))
        except (TypeError, ValueError):
            continue
        if end < start:
            end = start
        prepared_segments.append((start, end, text))
        texts.append(text)

    token_counts = token_counter.count_texts(texts)
    segments: list[SegmentUnit] = []
    for (start, end, text), token_count in zip(prepared_segments, token_counts, strict=True):
        segments.append(
            SegmentUnit(
                start=start,
                end=end,
                text=text,
                token_count=max(int(token_count), 1),
            )
        )
    return segments


def _join_segment_texts(segments: list[SegmentUnit]) -> str:
    return " ".join(segment.text for segment in segments).strip()


def _split_text_by_words(
    text: str,
    *,
    token_counter: TokenCounter,
    max_segment_tokens: int,
) -> list[str]:
    words = text.split()
    if not words:
        return []

    pieces: list[str] = []
    current_words: list[str] = []
    for word in words:
        candidate_words = current_words + [word]
        candidate_text = " ".join(candidate_words)
        if current_words and token_counter.count_text(candidate_text) > max_segment_tokens:
            pieces.append(" ".join(current_words))
            current_words = [word]
        else:
            current_words = candidate_words

    if current_words:
        pieces.append(" ".join(current_words))
    return pieces


def _split_segment_text(
    text: str,
    *,
    token_counter: TokenCounter,
    max_segment_tokens: int,
) -> list[str]:
    normalized = " ".join(text.split()).strip()
    if not normalized:
        return []

    total_tokens = token_counter.count_text(normalized)
    if total_tokens <= max_segment_tokens:
        return [normalized]

    for pattern in _SEGMENT_SPLIT_PATTERNS:
        parts = [part.strip() for part in pattern.split(normalized) if part.strip()]
        if len(parts) <= 1:
            continue

        split_parts: list[str] = []
        for part in parts:
            split_parts.extend(
                _split_segment_text(
                    part,
                    token_counter=token_counter,
                    max_segment_tokens=max_segment_tokens,
                )
            )
        if split_parts:
            return split_parts

    return _split_text_by_words(
        normalized,
        token_counter=token_counter,
        max_segment_tokens=max_segment_tokens,
    )


def _timed_subsegments(
    segment: SegmentUnit,
    *,
    texts: list[str],
    token_counter: TokenCounter,
) -> list[SegmentUnit]:
    if len(texts) <= 1:
        return [segment]

    duration = max(segment.end - segment.start, 0.0)
    weights = [max(sum(1 for ch in text if not ch.isspace()), 1) for text in texts]
    total_weight = sum(weights)
    cursor = segment.start
    subsegments: list[SegmentUnit] = []

    for index, (text, weight) in enumerate(zip(texts, weights, strict=True)):
        if index == len(texts) - 1 or duration == 0.0:
            next_end = segment.end
        else:
            next_end = cursor + duration * (weight / total_weight)
        subsegments.append(
            SegmentUnit(
                start=cursor,
                end=max(next_end, cursor),
                text=text,
                token_count=max(token_counter.count_text(text), 1),
            )
        )
        cursor = next_end

    return subsegments


def split_segments_for_chunking(
    segments: list[SegmentUnit],
    *,
    token_counter: TokenCounter,
    max_segment_tokens: int = CHUNK_MAX_SEGMENT_TOKENS,
) -> list[SegmentUnit]:
    """Split large transcript segments into chunker-friendly subsegments."""

    if max_segment_tokens <= 0:
        raise ValueError("max_segment_tokens must be positive.")

    prepared: list[SegmentUnit] = []
    for segment in segments:
        if segment.token_count <= max_segment_tokens:
            prepared.append(segment)
            continue

        split_texts = _split_segment_text(
            segment.text,
            token_counter=token_counter,
            max_segment_tokens=max_segment_tokens,
        )
        prepared.extend(
            _timed_subsegments(
                segment,
                texts=split_texts,
                token_counter=token_counter,
            )
        )

    return prepared


def chunk_segments(
    segments: list[SegmentUnit],
    *,
    token_counter: TokenCounter,
    min_tokens: int = 220,
    max_tokens: int = 300,
    overlap_tokens: int = 50,
) -> list[ChunkWindow]:
    """Create timeline-preserving chunk windows over segment units."""

    if not segments:
        return []

    if min_tokens <= 0 or max_tokens <= 0:
        raise ValueError("min_tokens and max_tokens must be positive.")
    if min_tokens > max_tokens:
        raise ValueError("min_tokens must be <= max_tokens.")
    if overlap_tokens < 0:
        raise ValueError("overlap_tokens must be >= 0.")

    windows: list[ChunkWindow] = []
    total_segments = len(segments)
    cursor = 0

    while cursor < total_segments:
        start_idx = cursor
        end_idx = cursor + 1
        chosen = [segments[start_idx]]
        text = chosen[0].text
        total_tokens = token_counter.count_text(text)

        while end_idx < total_segments:
            candidate_segments = segments[start_idx : end_idx + 1]
            candidate_text = _join_segment_texts(candidate_segments)
            candidate_tokens = token_counter.count_text(candidate_text)

            if total_tokens >= min_tokens and candidate_tokens > max_tokens:
                break

            chosen = candidate_segments
            text = candidate_text
            total_tokens = candidate_tokens
            end_idx += 1

            if total_tokens >= max_tokens:
                break

        start_sec = chosen[0].start
        end_sec = chosen[-1].end
        windows.append(
            ChunkWindow(
                start_index=start_idx,
                end_index=end_idx,
                start=start_sec,
                end=end_sec,
                token_count=total_tokens,
                text=text,
                is_overflow=(end_idx == start_idx + 1 and total_tokens > max_tokens),
            )
        )

        if end_idx >= total_segments:
            break

        next_cursor = end_idx
        while next_cursor > start_idx:
            candidate_cursor = next_cursor - 1
            overlap_text = _join_segment_texts(segments[candidate_cursor:end_idx])
            overlap_count = token_counter.count_text(overlap_text)
            next_cursor = candidate_cursor
            if overlap_count >= overlap_tokens:
                break

        if next_cursor <= start_idx:
            cursor = start_idx + 1
        else:
            cursor = next_cursor

    return windows


def summarize_token_counts(
    token_counts: list[int],
    *,
    tokenizer_model: str,
    min_tokens: int,
    max_tokens: int,
    overflow_single_segment_count: int = 0,
) -> ChunkTokenDistribution:
    """Summarize actual chunk token counts against a target band."""

    if min_tokens <= 0 or max_tokens <= 0:
        raise ValueError("min_tokens and max_tokens must be positive.")
    if min_tokens > max_tokens:
        raise ValueError("min_tokens must be <= max_tokens.")

    if not token_counts:
        return ChunkTokenDistribution(
            tokenizer_model=tokenizer_model,
            target_min_tokens=min_tokens,
            target_max_tokens=max_tokens,
            chunk_count=0,
            mean_tokens=0.0,
            median_tokens=0.0,
            min_tokens=0,
            max_tokens=0,
            within_target_count=0,
            below_target_count=0,
            above_target_count=0,
            within_target_fraction=0.0,
            below_target_fraction=0.0,
            above_target_fraction=0.0,
            overflow_single_segment_count=0,
            overflow_single_segment_fraction=0.0,
        )

    chunk_count = len(token_counts)
    within_target_count = sum(1 for count in token_counts if min_tokens <= count <= max_tokens)
    below_target_count = sum(1 for count in token_counts if count < min_tokens)
    above_target_count = sum(1 for count in token_counts if count > max_tokens)

    return ChunkTokenDistribution(
        tokenizer_model=tokenizer_model,
        target_min_tokens=min_tokens,
        target_max_tokens=max_tokens,
        chunk_count=chunk_count,
        mean_tokens=float(fmean(token_counts)),
        median_tokens=float(median(token_counts)),
        min_tokens=min(token_counts),
        max_tokens=max(token_counts),
        within_target_count=within_target_count,
        below_target_count=below_target_count,
        above_target_count=above_target_count,
        within_target_fraction=within_target_count / chunk_count,
        below_target_fraction=below_target_count / chunk_count,
        above_target_fraction=above_target_count / chunk_count,
        overflow_single_segment_count=overflow_single_segment_count,
        overflow_single_segment_fraction=overflow_single_segment_count / chunk_count,
    )


def summarize_chunk_windows(
    windows: list[ChunkWindow],
    *,
    token_counter: TokenCounter,
    min_tokens: int,
    max_tokens: int,
) -> ChunkTokenDistribution:
    """Summarize chunk windows produced by the tokenizer-aware chunker."""

    return summarize_token_counts(
        [window.token_count for window in windows],
        tokenizer_model=token_counter.model_name,
        min_tokens=min_tokens,
        max_tokens=max_tokens,
        overflow_single_segment_count=sum(1 for window in windows if window.is_overflow),
    )


def measure_chunk_texts(
    texts: list[str],
    *,
    token_counter: TokenCounter,
    min_tokens: int,
    max_tokens: int,
    overflow_single_segment_count: int = 0,
) -> ChunkTokenDistribution:
    """Measure actual token counts for an arbitrary chunk text sample."""

    token_counts = token_counter.count_texts(texts)
    return summarize_token_counts(
        [max(int(count), 1) for count in token_counts],
        tokenizer_model=token_counter.model_name,
        min_tokens=min_tokens,
        max_tokens=max_tokens,
        overflow_single_segment_count=overflow_single_segment_count,
    )


def _chunk_id(
    *,
    run_id: str,
    backend_key: str,
    audio_hash: str,
    start_sec: float,
    end_sec: float,
    chunk_version: str = CHUNK_VERSION,
) -> str:
    start_ms = int(round(start_sec * 1000))
    end_ms = int(round(end_sec * 1000))
    payload = f"{run_id}|{backend_key}|{audio_hash}|{start_ms}|{end_ms}|{chunk_version}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _discover_backend_transcripts(transcripts_root: Path, backend_key: str) -> list[Path]:
    workflow, model_component = backend_key.split("/", maxsplit=1)
    backend_dir = transcripts_root / workflow / model_component
    if not backend_dir.exists():
        return []
    return sorted(path for path in backend_dir.rglob("transcript.json") if path.is_file())
