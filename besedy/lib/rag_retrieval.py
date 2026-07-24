"""Phase 1 transcript-only RAG orchestration.

This module intentionally stays as the public facade for phase-1 retrieval so
existing imports continue to work. Data models, chunking/text helpers,
embedding/reranking providers, and sparse scoring live in adjacent modules.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from besedy.core.paths import (
    parse_transcript_components,
    require_run_id_from_transcripts_root,
    resolve_rag_phase1_root,
    resolve_transcripts_root,
)
from besedy.lib.data.encoding import load_json_with_fallback
from besedy.lib.rag_eval_records import load_eval_records, parse_eval_targets, record_query
from besedy.lib.rag_retrieval_chunking import (
    CHUNK_MAX_SEGMENT_TOKENS,
    CHUNK_SEGMENT_SPLIT_STRATEGY,
    CHUNK_VERSION,
    _chunk_id,
    _discover_backend_transcripts,
    _infer_audio_hash,
    _segments_from_transcript,
    chunk_segments,
    get_chunk_token_counter,
    normalize_backend_key,
    split_segments_for_chunking,
    summarize_chunk_windows,
)
from besedy.lib.rag_retrieval_providers import (
    RerankerProvider,
    _make_embedding_provider,
    _make_reranker_provider,
    _to_float32_normalized,
)
from besedy.lib.rag_retrieval_scoring import _bm25_scores, _build_bm25, _rrf_fuse
from besedy.lib.rag_retrieval_types import (
    IngestResult,
    QueryHit,
    QueryResult,
    RagChunk,
    SegmentUnit,  # noqa: F401
)


def ingest_phase1_index(
    *,
    backend_key: str,
    transcripts_root: Path | str | None = None,
    index_dir: Path | str = resolve_rag_phase1_root(),
    embedding_provider: str = "bge-m3",
    embedding_model: str | None = None,
    embedding_batch_size: int = 16,
    embedding_device: str | None = None,
    min_chunk_tokens: int = 220,
    max_chunk_tokens: int = 300,
    overlap_tokens: int = 50,
) -> IngestResult:
    """Build or refresh phase-1 retrieval index from transcript JSON."""

    normalized_backend = normalize_backend_key(backend_key)
    resolved_transcripts_root = resolve_transcripts_root(transcripts_root)
    if resolved_transcripts_root.is_symlink():
        resolved_transcripts_root = resolved_transcripts_root.resolve()
    run_id = require_run_id_from_transcripts_root(resolved_transcripts_root)

    provider = _make_embedding_provider(
        provider=embedding_provider,
        model=embedding_model,
        batch_size=embedding_batch_size,
        device=embedding_device,
    )
    chunk_token_counter = get_chunk_token_counter()

    transcript_paths = _discover_backend_transcripts(resolved_transcripts_root, normalized_backend)
    chunks_by_id: dict[str, RagChunk] = {}
    skipped = 0
    all_windows = []

    for transcript_path in transcript_paths:
        try:
            data = load_json_with_fallback(transcript_path)
        except (ValueError, FileNotFoundError):
            skipped += 1
            continue
        components = parse_transcript_components(transcript_path, resolved_transcripts_root)
        if components is None:
            skipped += 1
            continue
        workflow, model_component, hash_component = components
        file_backend = f"{workflow}/{model_component}"
        if file_backend != normalized_backend:
            continue

        audio_hash = _infer_audio_hash(hash_component, data)
        if audio_hash is None:
            skipped += 1
            continue

        segments = _segments_from_transcript(data, token_counter=chunk_token_counter)
        prepared_segments = split_segments_for_chunking(
            segments,
            token_counter=chunk_token_counter,
            max_segment_tokens=CHUNK_MAX_SEGMENT_TOKENS,
        )
        windows = chunk_segments(
            prepared_segments,
            token_counter=chunk_token_counter,
            min_tokens=min_chunk_tokens,
            max_tokens=max_chunk_tokens,
            overlap_tokens=overlap_tokens,
        )

        all_windows.extend(windows)

        for window in windows:
            cid = _chunk_id(
                run_id=run_id,
                backend_key=normalized_backend,
                audio_hash=audio_hash,
                start_sec=window.start,
                end_sec=window.end,
                chunk_version=CHUNK_VERSION,
            )
            chunks_by_id[cid] = RagChunk(
                chunk_id=cid,
                chunk_version=CHUNK_VERSION,
                run_id=run_id,
                backend_key=normalized_backend,
                audio_hash=audio_hash,
                source_path=str(transcript_path),
                start=window.start,
                end=window.end,
                token_count=window.token_count,
                text=window.text,
            )

    chunks = sorted(chunks_by_id.values(), key=lambda chunk: chunk.chunk_id)
    texts = [chunk.text for chunk in chunks]
    embeddings = provider.embed(texts) if texts else np.zeros((0, 0), dtype=np.float32)
    embeddings = _to_float32_normalized(embeddings)
    bm25_state = _build_bm25(chunks)
    chunk_distribution = summarize_chunk_windows(
        all_windows,
        token_counter=chunk_token_counter,
        min_tokens=min_chunk_tokens,
        max_tokens=max_chunk_tokens,
    )

    target_dir = Path(index_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    metadata = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "run_id": run_id,
        "backend_key": normalized_backend,
        "chunk_version": CHUNK_VERSION,
        "transcripts_root": str(resolved_transcripts_root),
        "embedding_provider": provider.name,
        "embedding_model": provider.model,
        "chunking": {
            "tokenizer_model": chunk_distribution.tokenizer_model,
            "segment_split_strategy": CHUNK_SEGMENT_SPLIT_STRATEGY,
            "max_segment_tokens": CHUNK_MAX_SEGMENT_TOKENS,
            "min_chunk_tokens": min_chunk_tokens,
            "max_chunk_tokens": max_chunk_tokens,
            "overlap_tokens": overlap_tokens,
        },
        "chunk_distribution": asdict(chunk_distribution),
        "counts": {
            "transcript_files": len(transcript_paths),
            "transcripts_skipped": skipped,
            "chunks_indexed": len(chunks),
        },
    }

    (target_dir / "index_meta.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    with (target_dir / "chunks.jsonl").open("w", encoding="utf-8") as handle:
        for chunk in chunks:
            handle.write(json.dumps(asdict(chunk), ensure_ascii=False) + "\n")
    np.save(target_dir / "embeddings.npy", embeddings)
    (target_dir / "bm25_index.json").write_text(
        json.dumps(bm25_state, ensure_ascii=False),
        encoding="utf-8",
    )

    return IngestResult(
        index_dir=str(target_dir),
        run_id=run_id,
        backend_key=normalized_backend,
        transcript_files=len(transcript_paths),
        transcripts_skipped=skipped,
        chunks_indexed=len(chunks),
        chunk_version=CHUNK_VERSION,
        embedding_provider=provider.name,
        embedding_model=provider.model,
        chunk_distribution=chunk_distribution,
    )


def _load_chunks(index_dir: Path) -> list[RagChunk]:
    path = index_dir / "chunks.jsonl"
    if not path.exists():
        return []
    chunks: list[RagChunk] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            chunks.append(RagChunk(**json.loads(line)))
    return chunks


def _load_index_meta(index_dir: Path) -> dict[str, Any]:
    path = index_dir / "index_meta.json"
    if not path.exists():
        raise FileNotFoundError(f"Missing index metadata: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def query_phase1_index(
    *,
    query: str,
    index_dir: Path | str = resolve_rag_phase1_root(),
    dense_top_k: int = 50,
    sparse_top_k: int = 50,
    final_k: int = 10,
    embedding_provider: str | None = None,
    embedding_model: str | None = None,
    embedding_batch_size: int = 16,
    embedding_device: str | None = None,
    reranker_provider: str | None = None,
    reranker_model: str | None = None,
    rerank_top_n: int = 0,
    reranker_batch_size: int = 8,
    reranker_device: str | None = None,
    reranker_max_length: int = 512,
) -> QueryResult:
    """Run a hybrid query against the phase-1 index."""

    if not query.strip():
        raise ValueError("Query must not be empty.")
    if rerank_top_n < 0:
        raise ValueError("rerank_top_n must be >= 0.")

    resolved_index_dir = Path(index_dir)
    chunks = _load_chunks(resolved_index_dir)
    if not chunks:
        return QueryResult(query=query, backend_key="", run_id="", hits=[])

    meta = _load_index_meta(resolved_index_dir)
    bm25_state = json.loads((resolved_index_dir / "bm25_index.json").read_text(encoding="utf-8"))
    embeddings = np.load(resolved_index_dir / "embeddings.npy")
    if embeddings.shape[0] != len(chunks):
        raise RuntimeError(
            "Embeddings row count does not match chunk count. Rebuild index with ingest command."
        )

    provider_name = embedding_provider or str(meta.get("embedding_provider", "hash"))
    provider_model = embedding_model or str(meta.get("embedding_model", ""))
    provider = _make_embedding_provider(
        provider=provider_name,
        model=provider_model or None,
        batch_size=embedding_batch_size,
        device=embedding_device,
    )
    query_vector = provider.embed([query])
    if query_vector.shape[0] == 0:
        raise RuntimeError("Failed to generate query embedding.")
    query_vector = _to_float32_normalized(query_vector)[0]

    dense_scores = embeddings @ query_vector
    dense_indices = np.argsort(dense_scores)[::-1][: max(dense_top_k, 0)]
    dense_ranked = dense_indices.tolist()

    sparse_ranked_with_scores = _bm25_scores(query, bm25_state, top_k=max(sparse_top_k, 0))
    sparse_ranked = [doc_idx for doc_idx, _score in sparse_ranked_with_scores]

    candidate_k = max(final_k, rerank_top_n)
    fused = _rrf_fuse(dense_ranked, sparse_ranked, final_k=max(candidate_k, 0))

    reranker: RerankerProvider | None = None
    if rerank_top_n > 0:
        reranker = _make_reranker_provider(
            provider=reranker_provider,
            model=reranker_model,
            batch_size=reranker_batch_size,
            device=reranker_device,
            max_length=reranker_max_length,
        )

    hits: list[QueryHit] = []
    if reranker is not None and rerank_top_n > 0 and fused:
        rerank_count = min(max(final_k, rerank_top_n), len(fused))
        rerank_candidates = fused[:rerank_count]
        rerank_texts = [chunks[doc_idx].text for doc_idx, _score, _dr, _sr in rerank_candidates]
        rerank_scores = reranker.score(query=query, texts=rerank_texts)
        if rerank_scores.shape[0] != len(rerank_candidates):
            raise RuntimeError("Reranker score count does not match rerank candidate count.")

        ranked_with_scores = list(zip(rerank_candidates, rerank_scores.tolist(), strict=True))
        ranked_with_scores.sort(key=lambda item: (item[1], item[0][1]), reverse=True)
        selected = ranked_with_scores[: max(final_k, 0)]

        for rank, ((doc_idx, fused_score, dense_rank, sparse_rank), rerank_score) in enumerate(
            selected, start=1
        ):
            chunk = chunks[doc_idx]
            hits.append(
                QueryHit(
                    rank=rank,
                    chunk_id=chunk.chunk_id,
                    score=rerank_score,
                    dense_rank=dense_rank,
                    sparse_rank=sparse_rank,
                    audio_hash=chunk.audio_hash,
                    backend_key=chunk.backend_key,
                    start=chunk.start,
                    end=chunk.end,
                    text=chunk.text,
                    fused_score=fused_score,
                    rerank_score=rerank_score,
                )
            )
    else:
        for rank, (doc_idx, score, dense_rank, sparse_rank) in enumerate(
            fused[: max(final_k, 0)], start=1
        ):
            chunk = chunks[doc_idx]
            hits.append(
                QueryHit(
                    rank=rank,
                    chunk_id=chunk.chunk_id,
                    score=score,
                    dense_rank=dense_rank,
                    sparse_rank=sparse_rank,
                    audio_hash=chunk.audio_hash,
                    backend_key=chunk.backend_key,
                    start=chunk.start,
                    end=chunk.end,
                    text=chunk.text,
                    fused_score=score,
                )
            )

    return QueryResult(
        query=query,
        backend_key=str(meta.get("backend_key", "")),
        run_id=str(meta.get("run_id", "")),
        hits=hits,
    )


def inspect_chunk(index_dir: Path | str, chunk_id: str) -> RagChunk | None:
    """Lookup a single chunk by id."""

    for chunk in _load_chunks(Path(index_dir)):
        if chunk.chunk_id == chunk_id:
            return chunk
    return None


def evaluate_phase1_recall(
    *,
    questions_path: Path | str,
    index_dir: Path | str = resolve_rag_phase1_root(),
    k: int = 10,
    dense_top_k: int = 50,
    sparse_top_k: int = 50,
    reranker_provider: str | None = None,
    reranker_model: str | None = None,
    rerank_top_n: int = 0,
    reranker_batch_size: int = 8,
    reranker_device: str | None = None,
    reranker_max_length: int = 512,
) -> dict[str, Any]:
    """Evaluate retrieval recall@k using a simple JSON question set."""

    records = load_eval_records(questions_path)

    total = 0
    hits = 0
    details: list[dict[str, Any]] = []

    for record in records:
        question = record_query(record)
        if not question:
            continue
        targets = parse_eval_targets(record)
        if not targets:
            continue

        total += 1
        result = query_phase1_index(
            query=question,
            index_dir=index_dir,
            dense_top_k=dense_top_k,
            sparse_top_k=sparse_top_k,
            final_k=k,
            reranker_provider=reranker_provider,
            reranker_model=reranker_model,
            rerank_top_n=rerank_top_n,
            reranker_batch_size=reranker_batch_size,
            reranker_device=reranker_device,
            reranker_max_length=reranker_max_length,
        )
        matched = False
        matched_hit: QueryHit | None = None
        for hit in result.hits:
            for target in targets:
                if target.matches(
                    chunk_id=hit.chunk_id,
                    audio_hash=hit.audio_hash,
                    start_sec=hit.start,
                    end_sec=hit.end,
                ):
                    matched = True
                    matched_hit = hit
                    break
            if matched:
                break

        if matched:
            hits += 1

        details.append(
            {
                "id": record.get("id"),
                "question": question,
                "matched": matched,
                "match_rank": matched_hit.rank if matched_hit else None,
                "matched_chunk_id": matched_hit.chunk_id if matched_hit else None,
            }
        )

    recall = (hits / total) if total else 0.0
    return {
        "total": total,
        "hits": hits,
        "recall_at_k": recall,
        "k": k,
        "details": details,
    }


def format_query_result_text(result: QueryResult) -> str:
    """Render a concise human-readable query result."""

    lines = [
        f"Query: {result.query}",
        f"Run: {result.run_id}",
        f"Backend: {result.backend_key}",
        f"Hits: {len(result.hits)}",
        "",
    ]
    for hit in result.hits:
        if hit.rerank_score is not None:
            score_text = (
                f"rerank={hit.rerank_score:.6f} fused={hit.fused_score:.6f}"
                if hit.fused_score is not None
                else f"rerank={hit.rerank_score:.6f}"
            )
        else:
            score_text = f"score={hit.score:.6f}"
        lines.append(
            f"[{hit.rank}] {score_text} dense={hit.dense_rank} sparse={hit.sparse_rank} "
            f"hash={hit.audio_hash} t={hit.start:.2f}-{hit.end:.2f}"
        )
        lines.append(f"    {hit.text}")
    return "\n".join(lines)
