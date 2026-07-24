"""Bundle metadata and artifact helpers for ColBERT sidecar indexes."""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Sequence
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from besedy.core.symlinks import validate_symlink_can_be_created
from besedy.lib.rag_bundle import (
    default_colbert_bundle_root,
    resolve_colbert_bundle_artifacts,
)
from besedy.lib.rag_chunk_corpus import TranscriptSource
from besedy.lib.rag_colbert_source_state import ColbertSourceStateRow
from besedy.lib.rag_colbert_types import (
    ColbertIndexResult,
    ColbertTokenAudit,
)
from besedy.lib.rag_pylate import (
    PYLATE_INDEX_FORMAT_VERSION,
    PYLATE_RETRIEVAL_ENGINE,
)
from besedy.lib.rag_retrieval_chunking import (
    CHUNK_MAX_SEGMENT_TOKENS,
    CHUNK_SEGMENT_SPLIT_STRATEGY,
)
from besedy.lib.rag_retrieval_types import ChunkTokenDistribution, RagChunk


def default_colbert_index_dir(
    *,
    workflow_group_id: str,
    backend_key: str,
    chunk_version: str,
    colbert_model: str,
) -> Path:
    """Return the stable symlink path for the default ColBERT sidecar index."""
    return default_colbert_bundle_root(
        workflow_group_id=workflow_group_id,
        backend_key=backend_key,
        chunk_version=chunk_version,
        colbert_model=colbert_model,
    ) / "index"


def _zero_token_audit(
    *,
    colbert_model: str,
    doc_maxlen: int,
) -> ColbertTokenAudit:
    return ColbertTokenAudit(
        tokenizer_name=colbert_model,
        doc_maxlen=doc_maxlen,
        chunk_count=0,
        max_tokens=0,
        p95_tokens=0.0,
        overflow_count=0,
        overflow_fraction=0.0,
    )


def _remove_existing_path(path: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if path.is_symlink() or path.is_file():
        path.unlink()
        return
    shutil.rmtree(path)


def _make_unique_bundle_dir(*, parent: Path, stem: str) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    base_name = f"{stem}_{timestamp}"
    candidate = parent / base_name
    suffix = 1
    while candidate.exists() or candidate.is_symlink():
        candidate = parent / f"{base_name}_{suffix:02d}"
        suffix += 1
    return candidate


def _index_target_paths(
    *,
    requested_index_dir: Path | None,
    workflow_group_id: str,
    backend_key: str,
    chunk_version: str,
    colbert_model: str,
    overwrite: bool,
) -> tuple[Path, Path, Path | None]:
    if requested_index_dir is not None:
        target_dir = requested_index_dir
        if target_dir.exists() or target_dir.is_symlink():
            if not overwrite:
                raise FileExistsError(f"ColBERT index path already exists: {target_dir}")
            _remove_existing_path(target_dir)
        target_dir.parent.mkdir(parents=True, exist_ok=True)
        return target_dir, target_dir, None

    exposed_index_dir = default_colbert_index_dir(
        workflow_group_id=workflow_group_id,
        backend_key=backend_key,
        chunk_version=chunk_version,
        colbert_model=colbert_model,
    )
    exposed_index_dir.parent.mkdir(parents=True, exist_ok=True)
    validate_symlink_can_be_created(exposed_index_dir, description="ColBERT index")
    target_dir = _make_unique_bundle_dir(parent=exposed_index_dir.parent, stem="index")
    return target_dir, exposed_index_dir, exposed_index_dir


def _coerce_token_audit(
    payload: dict[str, Any],
    *,
    colbert_model: str,
    doc_maxlen: int,
) -> ColbertTokenAudit:
    if not payload:
        return _zero_token_audit(colbert_model=colbert_model, doc_maxlen=doc_maxlen)
    return ColbertTokenAudit(
        tokenizer_name=str(payload.get("tokenizer_name", colbert_model)),
        doc_maxlen=int(payload.get("doc_maxlen", doc_maxlen)),
        chunk_count=int(payload.get("chunk_count", 0)),
        max_tokens=int(payload.get("max_tokens", 0)),
        p95_tokens=float(payload.get("p95_tokens", 0.0)),
        overflow_count=int(payload.get("overflow_count", 0)),
        overflow_fraction=float(payload.get("overflow_fraction", 0.0)),
    )


def _write_index_meta(
    *,
    target_dir: Path,
    workflow_group_id: str,
    backend_key: str,
    run_id: str,
    chunk_version: str,
    min_chunk_tokens: int,
    max_chunk_tokens: int,
    overlap_tokens: int,
    chunk_tokenizer_model: str,
    transcripts_root: str,
    colbert_model: str,
    doc_maxlen: int,
    index_bsize: int,
    use_faiss: bool,
    retrieval_engine_version: str,
    plaid_backend: str,
    chunk_count: int,
    token_audit: ColbertTokenAudit,
    chunk_distribution: ChunkTokenDistribution,
    chunking_fingerprint: str,
    bundle_fingerprint: str,
) -> None:
    built_at = datetime.now(timezone.utc).isoformat()
    metadata = {
        "created_at": built_at,
        "built_at": built_at,
        "workflow_group_id": workflow_group_id,
        "backend_key": backend_key,
        "run_id": run_id,
        "chunk_version": chunk_version,
        "min_chunk_tokens": min_chunk_tokens,
        "max_chunk_tokens": max_chunk_tokens,
        "overlap_tokens": overlap_tokens,
        "chunk_tokenizer_model": chunk_tokenizer_model,
        "chunking_fingerprint": chunking_fingerprint,
        "bundle_fingerprint": bundle_fingerprint,
        "transcripts_root": transcripts_root,
        "colbert_model": colbert_model,
        "doc_maxlen": doc_maxlen,
        "index_bsize": index_bsize,
        "split_documents": False,
        "use_faiss": use_faiss,
        "retrieval_engine": PYLATE_RETRIEVAL_ENGINE,
        "retrieval_engine_version": retrieval_engine_version,
        "index_format_version": PYLATE_INDEX_FORMAT_VERSION,
        "plaid_backend": plaid_backend,
        "chunk_count": chunk_count,
        "token_audit": asdict(token_audit),
        "chunk_distribution": asdict(chunk_distribution),
    }
    bundle_artifacts = resolve_colbert_bundle_artifacts(target_dir)
    bundle_artifacts.index_meta_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _stable_fingerprint(payload: dict[str, Any]) -> str:
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _build_chunking_fingerprint(
    *,
    chunk_version: str,
    min_chunk_tokens: int,
    max_chunk_tokens: int,
    overlap_tokens: int,
    chunk_tokenizer_model: str,
) -> str:
    return _stable_fingerprint(
        {
            "chunk_version": chunk_version,
            "min_chunk_tokens": min_chunk_tokens,
            "max_chunk_tokens": max_chunk_tokens,
            "overlap_tokens": overlap_tokens,
            "chunk_tokenizer_model": chunk_tokenizer_model,
            "max_segment_tokens": CHUNK_MAX_SEGMENT_TOKENS,
            "segment_split_strategy": CHUNK_SEGMENT_SPLIT_STRATEGY,
        }
    )


def _build_bundle_fingerprint(
    *,
    colbert_model: str,
    doc_maxlen: int,
    index_bsize: int,
    plaid_backend: str,
) -> str:
    return _stable_fingerprint(
        {
            "retrieval_engine": PYLATE_RETRIEVAL_ENGINE,
            "index_format_version": PYLATE_INDEX_FORMAT_VERSION,
            "plaid_backend": plaid_backend,
            "colbert_model": colbert_model,
            "doc_maxlen": doc_maxlen,
            "index_bsize": index_bsize,
        }
    )


def _build_source_state_rows(
    *,
    sources: Sequence[TranscriptSource],
    chunk_counts_by_hash: dict[str, int],
    chunking_fingerprint: str,
    bundle_fingerprint: str,
    run_id: str,
) -> list[ColbertSourceStateRow]:
    rows: list[ColbertSourceStateRow] = []
    for source in sorted(sources, key=lambda row: row.audio_hash):
        rows.append(
            ColbertSourceStateRow(
                audio_hash=source.audio_hash,
                transcript_path=source.transcript_path,
                transcript_fingerprint=source.transcript_fingerprint,
                chunking_fingerprint=chunking_fingerprint,
                bundle_fingerprint=bundle_fingerprint,
                chunk_count=int(chunk_counts_by_hash.get(source.audio_hash, 0)),
                last_run_id=run_id,
            )
        )
    return rows


def _coerce_index_result_from_meta(
    *,
    index_dir: Path | str,
    meta: dict[str, Any],
    sync_mode: str,
    default_colbert_model: str,
    default_doc_maxlen: int,
    default_index_bsize: int,
    target_audio_hash: str | None = None,
    hashes_discovered: int = 0,
    hashes_added: int = 0,
    hashes_updated: int = 0,
    hashes_removed: int = 0,
    hashes_unchanged: int = 0,
    hashes_failed: int = 0,
    chunks_inserted: int = 0,
    chunks_deleted: int = 0,
) -> ColbertIndexResult:
    token_audit = _coerce_token_audit(
        dict(meta.get("token_audit", {})) if isinstance(meta.get("token_audit"), dict) else {},
        colbert_model=str(meta.get("colbert_model", default_colbert_model)),
        doc_maxlen=int(meta.get("doc_maxlen", default_doc_maxlen)),
    )
    return ColbertIndexResult(
        index_dir=str(index_dir),
        workflow_group_id=str(meta["workflow_group_id"]),
        backend_key=str(meta["backend_key"]),
        run_id=str(meta["run_id"]),
        chunk_version=str(meta["chunk_version"]),
        min_chunk_tokens=int(meta["min_chunk_tokens"]),
        max_chunk_tokens=int(meta["max_chunk_tokens"]),
        overlap_tokens=int(meta["overlap_tokens"]),
        colbert_model=str(meta["colbert_model"]),
        doc_maxlen=int(meta["doc_maxlen"]),
        index_bsize=int(meta.get("index_bsize", default_index_bsize)),
        split_documents=bool(meta.get("split_documents", False)),
        use_faiss=bool(meta.get("use_faiss", False)),
        chunk_count=int(meta.get("chunk_count", 0)),
        token_audit=token_audit,
        retrieval_engine=str(meta["retrieval_engine"]) if meta.get("retrieval_engine") is not None else None,
        retrieval_engine_version=(
            str(meta["retrieval_engine_version"]) if meta.get("retrieval_engine_version") is not None else None
        ),
        index_format_version=(
            str(meta["index_format_version"]) if meta.get("index_format_version") is not None else None
        ),
        plaid_backend=str(meta["plaid_backend"]) if meta.get("plaid_backend") is not None else None,
        chunk_tokenizer_model=(
            str(meta["chunk_tokenizer_model"]) if meta.get("chunk_tokenizer_model") is not None else None
        ),
        chunking_fingerprint=(
            str(meta["chunking_fingerprint"]) if meta.get("chunking_fingerprint") is not None else None
        ),
        bundle_fingerprint=(
            str(meta["bundle_fingerprint"]) if meta.get("bundle_fingerprint") is not None else None
        ),
        sync_mode=sync_mode,
        target_audio_hash=target_audio_hash,
        hashes_discovered=hashes_discovered,
        hashes_added=hashes_added,
        hashes_updated=hashes_updated,
        hashes_removed=hashes_removed,
        hashes_unchanged=hashes_unchanged,
        hashes_failed=hashes_failed,
        chunks_inserted=chunks_inserted,
        chunks_deleted=chunks_deleted,
    )


def _write_chunk_manifest(*, target_dir: Path, chunks: Sequence[RagChunk]) -> None:
    bundle_artifacts = resolve_colbert_bundle_artifacts(target_dir)
    with bundle_artifacts.chunk_manifest_path.open("w", encoding="utf-8") as handle:
        for chunk in chunks:
            row = {
                "chunk_id": chunk.chunk_id,
                "audio_hash": chunk.audio_hash,
                "start_sec": chunk.start,
                "end_sec": chunk.end,
                "text": chunk.text,
                "run_id": chunk.run_id,
                "backend_key": chunk.backend_key,
                "chunk_version": chunk.chunk_version,
                "source_path": chunk.source_path,
                "token_count": chunk.token_count,
                "chunk_ordinal": chunk.chunk_ordinal,
            }
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def _read_index_meta(index_dir: Path | str) -> dict[str, Any]:
    path = resolve_colbert_bundle_artifacts(index_dir).index_meta_path
    if not path.exists():
        raise FileNotFoundError(f"Missing ColBERT index metadata: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _read_chunk_manifest(index_dir: Path | str) -> dict[str, dict[str, Any]]:
    path = resolve_colbert_bundle_artifacts(index_dir).chunk_manifest_path
    if not path.exists():
        raise FileNotFoundError(f"Missing ColBERT chunk manifest: {path}")

    rows: dict[str, dict[str, Any]] = {}
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            row = json.loads(stripped)
            chunk_id = str(row["chunk_id"])
            rows[chunk_id] = row
    return rows


def _extract_target_chunk_ids(records: list[dict[str, Any]]) -> list[str]:
    chunk_ids: set[str] = set()
    for record in records:
        targets = record.get("targets")
        if not isinstance(targets, list):
            continue
        for target in targets:
            if not isinstance(target, dict):
                continue
            chunk_id = target.get("chunk_id")
            if isinstance(chunk_id, str) and chunk_id.strip():
                chunk_ids.add(chunk_id.strip())
    return sorted(chunk_ids)


def validate_chunk_target_ids_against_manifest(
    *,
    index_dir: Path | str,
    records: list[dict[str, Any]],
) -> None:
    target_chunk_ids = _extract_target_chunk_ids(records)
    if not target_chunk_ids:
        return

    manifest_rows = _read_chunk_manifest(index_dir)
    missing_chunk_ids = [chunk_id for chunk_id in target_chunk_ids if chunk_id not in manifest_rows]
    if not missing_chunk_ids:
        return

    preview = ", ".join(missing_chunk_ids[:5])
    raise ValueError(
        "Chunk-target eval set does not match the current ColBERT index: "
        f"{len(missing_chunk_ids)} target chunk_id(s) are missing "
        f"(for example: {preview}). Rebuild the chunk-level eval set after chunk-version "
        "or chunk-layout changes."
    )


def _coerce_rag_chunk(payload: dict[str, Any]) -> RagChunk:
    return RagChunk(
        chunk_id=str(payload["chunk_id"]),
        chunk_version=str(payload["chunk_version"]),
        run_id=str(payload["run_id"]),
        backend_key=str(payload["backend_key"]),
        audio_hash=str(payload["audio_hash"]),
        source_path=str(payload["source_path"]),
        start=float(payload["start_sec"]),
        end=float(payload["end_sec"]),
        token_count=int(payload["token_count"]),
        text=str(payload["text"]),
        chunk_ordinal=int(payload["chunk_ordinal"]) if payload.get("chunk_ordinal") is not None else None,
    )
