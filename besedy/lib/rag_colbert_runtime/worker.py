#!/usr/bin/env python3
"""Isolated-environment worker for ColBERT indexing and querying."""

from __future__ import annotations

import contextlib
import inspect
import json
import math
import sys
import time
from itertools import chain
from pathlib import Path
from typing import Any, Iterable, Iterator, cast

from besedy.lib import rag_pylate
from besedy.lib.rag_bundle import resolve_colbert_bundle_artifacts
from besedy.lib.rag_chunk_store import (
    ChunkNeighbors,
    LexicalMatchMode,
    lookup_chunk_neighbors,
    lookup_chunks,
    search_chunks_fts,
)
from besedy.lib.rag_retrieval_types import RagChunk

PYLATE_TOKEN_AUDIT_BATCH_SIZE = 512
# PyLate does not expose a truly streaming fresh-build API, so full rebuilds seed
# the index from a representative bootstrap subset and stream the remaining
# documents through incremental updates to keep memory bounded.
PYLATE_FULL_BUILD_BOOTSTRAP_DOCS = 2048
PYLATE_FULL_BUILD_UPDATE_DOCS = 256


def _read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("Worker payload must be a JSON object.")
    return payload


def _load_manifest_rows(manifest_path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with manifest_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            row = json.loads(stripped)
            if not isinstance(row, dict):
                raise ValueError(f"Invalid manifest row: {line!r}")
            rows.append(row)
    return rows


def _call_with_supported_kwargs(func, /, **kwargs):
    try:
        signature = inspect.signature(func)
    except (TypeError, ValueError):
        return func(**kwargs)

    if any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    ):
        return func(**kwargs)

    accepted_kwargs = {}
    dropped_kwargs = []
    for name, value in kwargs.items():
        if name in signature.parameters:
            accepted_kwargs[name] = value
        else:
            dropped_kwargs.append(name)
    if dropped_kwargs:
        print(
            f"rag_colbert_worker: ignored unsupported kwargs for {getattr(func, '__name__', func)!s}: "
            + ", ".join(sorted(dropped_kwargs)),
            file=sys.stderr,
        )
    return func(**accepted_kwargs)


def _serialize_chunk(chunk: RagChunk) -> dict[str, Any]:
    return {
        "chunk_id": chunk.chunk_id,
        "audio_hash": chunk.audio_hash,
        "chunk_ordinal": chunk.chunk_ordinal,
        "start_sec": chunk.start,
        "end_sec": chunk.end,
        "text": chunk.text,
        "run_id": chunk.run_id,
        "backend_key": chunk.backend_key,
        "chunk_version": chunk.chunk_version,
        "token_count": chunk.token_count,
        "source_path": chunk.source_path,
    }


def _serialize_neighbors(neighbors: dict[str, ChunkNeighbors]) -> dict[str, Any]:
    return {
        chunk_id: {
            "before": [_serialize_chunk(chunk) for chunk in chunk_neighbors.before],
            "after": [_serialize_chunk(chunk) for chunk in chunk_neighbors.after],
        }
        for chunk_id, chunk_neighbors in neighbors.items()
    }


def _require_chunk_ids(payload: dict[str, Any]) -> list[str]:
    raw_chunk_ids = payload.get("chunk_ids", [])
    if raw_chunk_ids is None:
        return []
    if not isinstance(raw_chunk_ids, list):
        raise ValueError("chunk_ids must be a JSON array.")

    chunk_ids: list[str] = []
    for raw_chunk_id in raw_chunk_ids:
        if not isinstance(raw_chunk_id, str) or not raw_chunk_id.strip():
            raise ValueError("chunk_ids must contain non-empty strings.")
        chunk_ids.append(raw_chunk_id)
    return chunk_ids


def _resolve_chunk_store_path(payload: dict[str, Any]) -> Path:
    raw_index_dir = payload.get("colbert_index_dir")
    if not isinstance(raw_index_dir, str) or not raw_index_dir.strip():
        raise ValueError("colbert_index_dir is required.")

    resolved_index_dir = Path(raw_index_dir).resolve()
    if not resolved_index_dir.exists():
        raise FileNotFoundError(f"ColBERT index directory does not exist: {resolved_index_dir}")

    chunk_store_path = resolve_colbert_bundle_artifacts(resolved_index_dir.parent).chunk_store_path
    if not chunk_store_path.exists():
        raise FileNotFoundError(f"ColBERT chunk store does not exist: {chunk_store_path}")
    return chunk_store_path


def _format_elapsed(seconds: float) -> str:
    total_seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def _log_phase_start(phase_index: int, label: str) -> float:
    print(f"Phase {phase_index}/6: {label}...", file=sys.stderr, flush=True)
    return time.perf_counter()


def _log_phase_complete(
    phase_index: int, phase_started_at: float, detail: str | None = None
) -> None:
    message = f"Phase {phase_index}/6 complete in {_format_elapsed(time.perf_counter() - phase_started_at)}"
    if detail:
        message = f"{message} | {detail}"
    print(message, file=sys.stderr, flush=True)


def _iter_batches(items: list[Any], *, batch_size: int) -> Iterator[list[Any]]:
    if batch_size <= 0:
        raise ValueError("batch_size must be positive.")

    for start in range(0, len(items), batch_size):
        yield items[start : start + batch_size]


def _iter_text_batches(texts: Iterable[str], *, batch_size: int) -> Iterator[list[str]]:
    if batch_size <= 0:
        raise ValueError("batch_size must be positive.")

    batch: list[str] = []
    for raw_text in texts:
        batch.append(str(raw_text))
        if len(batch) >= batch_size:
            yield batch
            batch = []

    if batch:
        yield batch


def _select_uniform_sample_indices(*, total_count: int, sample_count: int) -> set[int]:
    if total_count <= 0 or sample_count <= 0:
        return set()
    if sample_count >= total_count:
        return set(range(total_count))
    if sample_count == 1:
        return {0}

    step = (total_count - 1) / (sample_count - 1)
    indices = {int(round(position * step)) for position in range(sample_count)}
    if len(indices) < sample_count:
        for index in range(total_count):
            indices.add(index)
            if len(indices) >= sample_count:
                break
    return indices


def _split_bootstrap_rows(
    rows: list[dict[str, Any]], *, bootstrap_doc_count: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    selected_indices = _select_uniform_sample_indices(
        total_count=len(rows),
        sample_count=min(len(rows), max(1, bootstrap_doc_count)),
    )
    bootstrap_rows = [row for index, row in enumerate(rows) if index in selected_indices]
    remaining_rows = [row for index, row in enumerate(rows) if index not in selected_indices]
    return bootstrap_rows, remaining_rows


def _encode_document_rows(
    *, model, rows: list[dict[str, Any]], index_bsize: int
) -> tuple[list[str], Any]:
    if not rows:
        return [], []

    texts = [str(row["text"]) for row in rows]
    chunk_ids = [str(row["chunk_id"]) for row in rows]
    embeddings = model.encode(
        texts,
        batch_size=index_bsize,
        is_query=False,
        show_progress_bar=False,
    )
    return chunk_ids, embeddings


def _audit_tokens(*, texts: Iterable[str], colbert_model: str, doc_maxlen: int) -> dict[str, Any]:
    text_batches = _iter_text_batches(texts, batch_size=PYLATE_TOKEN_AUDIT_BATCH_SIZE)
    try:
        first_batch = next(text_batches)
    except StopIteration:
        return {
            "tokenizer_name": colbert_model,
            "doc_maxlen": doc_maxlen,
            "chunk_count": 0,
            "max_tokens": 0,
            "p95_tokens": 0.0,
            "overflow_count": 0,
            "overflow_fraction": 0.0,
        }

    import numpy as np
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(
        colbert_model, use_fast=True, trust_remote_code=True
    )
    if not callable(tokenizer):
        raise RuntimeError(f"Tokenizer for {colbert_model} is not callable.")
    token_counts: list[int] = []
    for text_batch in chain([first_batch], text_batches):
        encoded = tokenizer(
            text_batch,
            add_special_tokens=False,
            padding=False,
            truncation=False,
            return_attention_mask=False,
            return_token_type_ids=False,
        )
        input_ids = encoded.get("input_ids", [])
        token_counts.extend(max(len(ids), 1) for ids in input_ids)
    overflow_count = sum(1 for count in token_counts if count > doc_maxlen)
    chunk_count = len(token_counts)
    return {
        "tokenizer_name": colbert_model,
        "doc_maxlen": doc_maxlen,
        "chunk_count": chunk_count,
        "max_tokens": max(token_counts),
        "p95_tokens": float(np.percentile(token_counts, 95)),
        "overflow_count": overflow_count,
        "overflow_fraction": (overflow_count / chunk_count) if chunk_count else 0.0,
    }


def _ensure_model_snapshot(model_name: str) -> None:
    model_path = Path(model_name)
    if model_path.exists():
        return

    from huggingface_hub import snapshot_download

    snapshot_download(model_name)


def _read_bundle_meta(index_dir: Path) -> dict[str, Any]:
    bundle_artifacts = resolve_colbert_bundle_artifacts(index_dir.parent)
    meta_path = bundle_artifacts.index_meta_path
    if not meta_path.exists():
        raise FileNotFoundError(f"ColBERT bundle metadata does not exist: {meta_path}")

    payload = json.loads(meta_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Invalid ColBERT bundle metadata payload at {meta_path}")
    return payload


def _resolve_plaid_backend(payload: dict[str, Any], *, meta: dict[str, Any] | None = None) -> str:
    raw_backend = payload.get("plaid_backend")
    if isinstance(raw_backend, str) and raw_backend.strip():
        return rag_pylate.normalize_plaid_backend(raw_backend)

    if meta is not None:
        meta_backend = meta.get("plaid_backend")
        if isinstance(meta_backend, str) and meta_backend.strip():
            return rag_pylate.normalize_plaid_backend(meta_backend)

    return rag_pylate.DEFAULT_PYLATE_PLAID_BACKEND


def _resolve_colbert_model_name(
    payload: dict[str, Any], *, meta: dict[str, Any] | None = None
) -> str:
    raw_model = payload.get("colbert_model")
    if isinstance(raw_model, str) and raw_model.strip():
        return raw_model

    if meta is not None:
        meta_model = meta.get("colbert_model")
        if isinstance(meta_model, str) and meta_model.strip():
            return meta_model

    raise ValueError("colbert_model is required.")


def _engine_payload(*, plaid_backend: str) -> dict[str, str]:
    return rag_pylate.get_engine_metadata(plaid_backend=plaid_backend)


def _warn_legacy_flag(flag_name: str) -> None:
    print(
        f"rag_colbert_worker: ignoring deprecated {flag_name} under the PyLate runtime",
        file=sys.stderr,
        flush=True,
    )


def _build_index(payload: dict[str, Any]) -> dict[str, Any]:
    manifest_path = Path(str(payload["manifest_path"]))
    destination = Path(str(payload["colbert_index_dir"]))
    colbert_model = _resolve_colbert_model_name(payload)
    plaid_backend = _resolve_plaid_backend(payload)
    doc_maxlen = int(payload["doc_maxlen"])
    index_bsize = int(payload.get("index_bsize", 32))
    use_faiss = bool(payload.get("use_faiss", False))
    if index_bsize <= 0:
        raise ValueError("index_bsize must be positive.")
    if use_faiss:
        _warn_legacy_flag("use_faiss")

    rows = _load_manifest_rows(manifest_path)
    audit_started_at = _log_phase_start(4, "auditing token lengths")
    token_audit = _audit_tokens(
        texts=(str(row["text"]) for row in rows),
        colbert_model=colbert_model,
        doc_maxlen=doc_maxlen,
    )
    _log_phase_complete(
        4,
        audit_started_at,
        detail=(
            f"chunks={len(rows)} | overflow_chunks={int(token_audit.get('overflow_count', 0))}"
        ),
    )

    if not rows:
        print(
            "Phase 5/6: indexing with ColBERT skipped (empty corpus)",
            file=sys.stderr,
            flush=True,
        )
        destination.mkdir(parents=True, exist_ok=True)
        return {
            "token_audit": token_audit,
            "colbert_index_dir": str(destination),
            **_engine_payload(plaid_backend=plaid_backend),
        }

    index_started_at = _log_phase_start(5, "indexing with ColBERT")
    _ensure_model_snapshot(colbert_model)
    device = rag_pylate.resolve_pylate_device()
    model = rag_pylate.build_pylate_model(
        colbert_model=colbert_model,
        device=device,
        doc_maxlen=doc_maxlen,
    )
    index = rag_pylate.open_pylate_index(
        index_dir=destination,
        plaid_backend=plaid_backend,
        override=True,
        device=device,
    )
    bootstrap_rows, remaining_rows = _split_bootstrap_rows(
        rows,
        bootstrap_doc_count=PYLATE_FULL_BUILD_BOOTSTRAP_DOCS,
    )
    bootstrap_chunk_ids, document_embeddings = _encode_document_rows(
        model=model,
        rows=bootstrap_rows,
        index_bsize=index_bsize,
    )
    index.add_documents(
        documents_ids=bootstrap_chunk_ids,
        documents_embeddings=document_embeddings,
    )

    update_doc_batch_size = max(1, PYLATE_FULL_BUILD_UPDATE_DOCS)
    remaining_batch_count = (
        math.ceil(len(remaining_rows) / update_doc_batch_size) if remaining_rows else 0
    )
    if remaining_batch_count:
        print(
            "rag_colbert_worker: full rebuild is using memory-bounded bootstrap+update indexing "
            f"(bootstrap_docs={len(bootstrap_rows)}, update_batches={remaining_batch_count})",
            file=sys.stderr,
            flush=True,
        )
    for batch_rows in _iter_batches(remaining_rows, batch_size=update_doc_batch_size):
        batch_chunk_ids, batch_embeddings = _encode_document_rows(
            model=model,
            rows=batch_rows,
            index_bsize=index_bsize,
        )
        index.add_documents(
            documents_ids=batch_chunk_ids,
            documents_embeddings=batch_embeddings,
        )
    if not destination.exists():
        raise RuntimeError(
            f"PyLate index build did not create the destination directory: {destination}"
        )
    build_detail = f"backend={plaid_backend}"
    if remaining_batch_count:
        build_detail = (
            f"{build_detail} | bootstrap_docs={len(bootstrap_rows)} | "
            f"update_batches={remaining_batch_count}"
        )
    _log_phase_complete(5, index_started_at, detail=build_detail)
    return {
        "token_audit": token_audit,
        "colbert_index_dir": str(destination),
        **_engine_payload(plaid_backend=plaid_backend),
    }


def _query_index(payload: dict[str, Any]) -> dict[str, Any]:
    index_dir = Path(str(payload["colbert_index_dir"]))
    meta = _read_bundle_meta(index_dir)
    colbert_model = _resolve_colbert_model_name(payload, meta=meta)
    plaid_backend = _resolve_plaid_backend(payload, meta=meta)
    doc_maxlen = int(meta.get("doc_maxlen", payload.get("doc_maxlen", 384)))
    query = str(payload["query"])
    k = int(payload.get("k", 10))
    force_fast = bool(payload.get("force_fast", False))
    if force_fast:
        _warn_legacy_flag("force_fast")

    device = rag_pylate.resolve_pylate_device()
    model = rag_pylate.build_pylate_model(
        colbert_model=colbert_model,
        device=device,
        doc_maxlen=doc_maxlen,
    )
    index = rag_pylate.open_pylate_index(
        index_dir=index_dir,
        plaid_backend=plaid_backend,
        override=False,
        device=device,
    )
    retriever = rag_pylate.create_pylate_retriever(index=index)
    query_embeddings = model.encode(
        [query],
        batch_size=1,
        is_query=True,
        show_progress_bar=False,
    )
    results = _call_with_supported_kwargs(
        retriever.retrieve,
        queries_embeddings=query_embeddings,
        k=k,
        device=device,
        batch_size=1,
    )
    return {
        "hits": rag_pylate.normalize_pylate_hits(results),
        **_engine_payload(plaid_backend=plaid_backend),
    }


def _add_to_index(payload: dict[str, Any]) -> dict[str, Any]:
    index_dir = Path(str(payload["colbert_index_dir"]))
    meta = _read_bundle_meta(index_dir)
    colbert_model = _resolve_colbert_model_name(payload, meta=meta)
    plaid_backend = _resolve_plaid_backend(payload, meta=meta)
    doc_maxlen = int(meta.get("doc_maxlen", payload.get("doc_maxlen", 384)))
    raw_rows = payload.get("rows", [])
    if not isinstance(raw_rows, list):
        raise ValueError("rows must be a JSON array.")
    index_bsize = int(payload.get("index_bsize", 32))
    use_faiss = bool(payload.get("use_faiss", False))
    if index_bsize <= 0:
        raise ValueError("index_bsize must be positive.")
    if use_faiss:
        _warn_legacy_flag("use_faiss")

    rows = [row for row in raw_rows if isinstance(row, dict)]
    if not rows:
        return {"added_chunk_ids": [], **_engine_payload(plaid_backend=plaid_backend)}

    device = rag_pylate.resolve_pylate_device()
    model = rag_pylate.build_pylate_model(
        colbert_model=colbert_model,
        device=device,
        doc_maxlen=doc_maxlen,
    )
    document_embeddings = model.encode(
        [str(row["text"]) for row in rows],
        batch_size=index_bsize,
        is_query=False,
        show_progress_bar=False,
    )
    index = rag_pylate.open_pylate_index(
        index_dir=index_dir,
        plaid_backend=plaid_backend,
        override=False,
        device=device,
    )
    index.add_documents(
        documents_ids=[str(row["chunk_id"]) for row in rows],
        documents_embeddings=document_embeddings,
    )
    return {
        "added_chunk_ids": [str(row["chunk_id"]) for row in rows],
        **_engine_payload(plaid_backend=plaid_backend),
    }


def _delete_from_index(payload: dict[str, Any]) -> dict[str, Any]:
    index_dir = Path(str(payload["colbert_index_dir"]))
    meta = _read_bundle_meta(index_dir)
    plaid_backend = _resolve_plaid_backend(payload, meta=meta)
    chunk_ids = _require_chunk_ids(payload)
    if not chunk_ids:
        return {"deleted_chunk_ids": [], **_engine_payload(plaid_backend=plaid_backend)}

    device = rag_pylate.resolve_pylate_device()
    index = rag_pylate.open_pylate_index(
        index_dir=index_dir,
        plaid_backend=plaid_backend,
        override=False,
        device=device,
    )
    index.remove_documents(chunk_ids)
    return {"deleted_chunk_ids": chunk_ids, **_engine_payload(plaid_backend=plaid_backend)}


def _lookup_chunks(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_store_path = _resolve_chunk_store_path(payload)
    chunk_ids = _require_chunk_ids(payload)
    chunks = lookup_chunks(path=chunk_store_path, chunk_ids=chunk_ids)
    return {"chunks": [_serialize_chunk(chunk) for chunk in chunks]}


def _lookup_neighbors(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_store_path = _resolve_chunk_store_path(payload)
    chunk_ids = _require_chunk_ids(payload)
    neighbor_count = int(payload.get("neighbor_count", 0))
    if neighbor_count <= 0:
        raise ValueError("neighbor_count must be positive.")

    neighbors = lookup_chunk_neighbors(
        path=chunk_store_path,
        chunk_ids=chunk_ids,
        neighbor_count=neighbor_count,
    )
    return {"neighbors": _serialize_neighbors(neighbors)}


def _search_chunks_lexical(payload: dict[str, Any]) -> dict[str, Any]:
    chunk_store_path = _resolve_chunk_store_path(payload)
    raw_query = payload.get("query")
    if not isinstance(raw_query, str) or not raw_query.strip():
        raise ValueError("query must be a non-empty string.")
    raw_allowed_hashes = payload.get("allowed_audio_hashes")
    if not isinstance(raw_allowed_hashes, list):
        raise ValueError("allowed_audio_hashes must be a JSON array.")
    allowed_audio_hashes: list[str] = []
    for value in raw_allowed_hashes:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("allowed_audio_hashes must contain non-empty strings.")
        allowed_audio_hashes.append(value)

    raw_match_mode = payload.get("match_mode", "all_terms")
    if raw_match_mode not in {"all_terms", "phrase", "any_term", "prefix"}:
        raise ValueError(f"Unsupported lexical match mode: {raw_match_mode}")

    result = search_chunks_fts(
        path=chunk_store_path,
        query=raw_query,
        match_mode=cast(LexicalMatchMode, raw_match_mode),
        limit=int(payload.get("limit", 50)),
        max_per_audio=int(payload.get("max_per_audio", 10)),
        allowed_audio_hashes=allowed_audio_hashes,
    )
    return {
        "matches": [
            {**_serialize_chunk(match.chunk), "score": match.score} for match in result.matches
        ],
        "total_matches": result.total_matches,
    }


def main(argv: list[str] | None = None) -> int:
    args = argv or sys.argv[1:]
    if not args:
        raise SystemExit(
            "Usage: python -m besedy.lib.rag_colbert_runtime.worker "
            "<audit-tokens|build-index|add-to-index|delete-from-index|query-index|lookup-chunks|lookup-neighbors|lexical-search>"
        )

    command = args[0]
    payload = _read_payload()
    if command == "audit-tokens":
        result = _audit_tokens(
            texts=[str(text) for text in payload.get("texts", [])],
            colbert_model=str(payload["colbert_model"]),
            doc_maxlen=int(payload["doc_maxlen"]),
        )
    elif command == "build-index":
        with contextlib.redirect_stdout(sys.stderr):
            result = _build_index(payload)
    elif command == "add-to-index":
        with contextlib.redirect_stdout(sys.stderr):
            result = _add_to_index(payload)
    elif command == "delete-from-index":
        with contextlib.redirect_stdout(sys.stderr):
            result = _delete_from_index(payload)
    elif command == "query-index":
        with contextlib.redirect_stdout(sys.stderr):
            result = _query_index(payload)
    elif command == "lookup-chunks":
        result = _lookup_chunks(payload)
    elif command == "lookup-neighbors":
        result = _lookup_neighbors(payload)
    elif command == "lexical-search":
        result = _search_chunks_lexical(payload)
    else:
        raise SystemExit(f"Unknown worker command: {command}")

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
