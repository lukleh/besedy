"""Types for ColBERT sidecar indexing and retrieval."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ColbertTokenAudit:
    tokenizer_name: str
    doc_maxlen: int
    chunk_count: int
    max_tokens: int
    p95_tokens: float
    overflow_count: int
    overflow_fraction: float


@dataclass(frozen=True)
class ColbertIndexResult:
    index_dir: str
    workflow_group_id: str
    backend_key: str
    run_id: str
    chunk_version: str
    min_chunk_tokens: int
    max_chunk_tokens: int
    overlap_tokens: int
    colbert_model: str
    doc_maxlen: int
    index_bsize: int
    split_documents: bool
    use_faiss: bool
    chunk_count: int
    token_audit: ColbertTokenAudit
    retrieval_engine: str | None = None
    retrieval_engine_version: str | None = None
    index_format_version: str | None = None
    plaid_backend: str | None = None
    chunk_tokenizer_model: str | None = None
    chunking_fingerprint: str | None = None
    bundle_fingerprint: str | None = None
    sync_mode: str | None = None
    target_audio_hash: str | None = None
    hashes_discovered: int = 0
    hashes_added: int = 0
    hashes_updated: int = 0
    hashes_removed: int = 0
    hashes_unchanged: int = 0
    hashes_failed: int = 0
    chunks_inserted: int = 0
    chunks_deleted: int = 0


@dataclass(frozen=True)
class ColbertQueryHit:
    rank: int
    chunk_id: str
    audio_hash: str
    start_sec: float
    end_sec: float
    text: str
    score: float
    chunk_ordinal: int | None = None
    document_metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class ColbertQueryResult:
    query: str
    index_dir: str
    workflow_group_id: str
    backend_key: str
    run_id: str
    chunk_version: str
    colbert_model: str
    doc_maxlen: int
    hits: list[ColbertQueryHit]
    min_chunk_tokens: int | None = None
    max_chunk_tokens: int | None = None
    overlap_tokens: int | None = None


__all__ = [
    "ColbertIndexResult",
    "ColbertQueryHit",
    "ColbertQueryResult",
    "ColbertTokenAudit",
]
