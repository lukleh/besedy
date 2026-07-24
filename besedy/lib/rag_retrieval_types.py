"""Shared result/data shapes for transcript-only RAG retrieval."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SegmentUnit:
    """Internal normalized segment for chunking."""

    start: float
    end: float
    text: str
    token_count: int


@dataclass(frozen=True)
class ChunkWindow:
    """One chunk window over transcript segments."""

    start_index: int
    end_index: int
    start: float
    end: float
    token_count: int
    text: str
    is_overflow: bool


@dataclass(frozen=True)
class ChunkTokenDistribution:
    """Summary of actual chunk token counts for one ingest run."""

    tokenizer_model: str
    target_min_tokens: int
    target_max_tokens: int
    chunk_count: int
    mean_tokens: float
    median_tokens: float
    min_tokens: int
    max_tokens: int
    within_target_count: int
    below_target_count: int
    above_target_count: int
    within_target_fraction: float
    below_target_fraction: float
    above_target_fraction: float
    overflow_single_segment_count: int
    overflow_single_segment_fraction: float


@dataclass(frozen=True)
class RagChunk:
    """Indexed retrieval chunk."""

    chunk_id: str
    chunk_version: str
    run_id: str
    backend_key: str
    audio_hash: str
    source_path: str
    start: float
    end: float
    token_count: int
    text: str
    chunk_ordinal: int | None = None


@dataclass(frozen=True)
class IngestResult:
    """Summary after index build."""

    index_dir: str
    run_id: str
    backend_key: str
    transcript_files: int
    transcripts_skipped: int
    chunks_indexed: int
    chunk_version: str
    embedding_provider: str
    embedding_model: str
    chunk_distribution: ChunkTokenDistribution | None = None


@dataclass(frozen=True)
class QueryHit:
    """Query result row."""

    rank: int
    chunk_id: str
    score: float
    dense_rank: int | None
    sparse_rank: int | None
    audio_hash: str
    backend_key: str
    start: float
    end: float
    text: str
    fused_score: float | None = None
    rerank_score: float | None = None


@dataclass(frozen=True)
class QueryResult:
    """Query result payload."""

    query: str
    backend_key: str
    run_id: str
    hits: list[QueryHit]
