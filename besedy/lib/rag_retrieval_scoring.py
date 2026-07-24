"""Sparse/hybrid scoring helpers for transcript-only RAG retrieval."""

from __future__ import annotations

import math
from typing import Any

from .rag_retrieval_chunking import _tokenize
from .rag_retrieval_types import RagChunk


def _build_bm25(chunks: list[RagChunk], *, k1: float = 1.5, b: float = 0.75) -> dict[str, Any]:
    """Build JSON-serializable BM25 index state."""

    if not chunks:
        return {
            "k1": k1,
            "b": b,
            "N": 0,
            "avgdl": 0.0,
            "doc_lens": [],
            "idf": {},
            "postings": {},
        }

    doc_tokens: list[list[str]] = [_tokenize(chunk.text) for chunk in chunks]
    doc_lens = [max(len(tokens), 1) for tokens in doc_tokens]
    avgdl = float(sum(doc_lens)) / len(doc_lens)
    total_docs = len(chunks)

    postings_dict: dict[str, dict[int, int]] = {}
    df: dict[str, int] = {}
    for doc_idx, tokens in enumerate(doc_tokens):
        freqs: dict[str, int] = {}
        for token in tokens:
            freqs[token] = freqs.get(token, 0) + 1
        for token, tf in freqs.items():
            term_postings = postings_dict.setdefault(token, {})
            term_postings[doc_idx] = tf
            df[token] = df.get(token, 0) + 1

    idf = {
        term: math.log(1.0 + (total_docs - doc_df + 0.5) / (doc_df + 0.5))
        for term, doc_df in df.items()
    }

    postings = {
        term: [[doc_idx, tf] for doc_idx, tf in sorted(term_postings.items())]
        for term, term_postings in postings_dict.items()
    }

    return {
        "k1": k1,
        "b": b,
        "N": total_docs,
        "avgdl": avgdl,
        "doc_lens": doc_lens,
        "idf": idf,
        "postings": postings,
    }


def _bm25_scores(query: str, bm25_state: dict[str, Any], *, top_k: int) -> list[tuple[int, float]]:
    tokens = _tokenize(query)
    if not tokens or top_k <= 0:
        return []

    idf: dict[str, float] = bm25_state.get("idf", {})
    postings: dict[str, list[list[int]]] = bm25_state.get("postings", {})
    doc_lens: list[int] = bm25_state.get("doc_lens", [])
    avgdl = float(bm25_state.get("avgdl", 0.0) or 1.0)
    k1 = float(bm25_state.get("k1", 1.5))
    b = float(bm25_state.get("b", 0.75))

    scores: dict[int, float] = {}
    for term in set(tokens):
        term_idf = idf.get(term)
        term_postings = postings.get(term)
        if term_idf is None or term_postings is None:
            continue
        for doc_idx, tf in term_postings:
            dl = doc_lens[doc_idx]
            denom = tf + k1 * (1.0 - b + b * (dl / avgdl))
            increment = term_idf * ((tf * (k1 + 1.0)) / max(denom, 1e-9))
            scores[doc_idx] = scores.get(doc_idx, 0.0) + increment

    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    return ranked[:top_k]


def _rrf_fuse(
    dense_ranked: list[int],
    sparse_ranked: list[int],
    *,
    rrf_k: int = 60,
    final_k: int,
) -> list[tuple[int, float, int | None, int | None]]:
    """Fuse rankings with reciprocal rank fusion."""

    if final_k <= 0:
        return []

    accum: dict[int, float] = {}
    dense_ranks: dict[int, int] = {}
    sparse_ranks: dict[int, int] = {}

    for rank, doc_idx in enumerate(dense_ranked, start=1):
        accum[doc_idx] = accum.get(doc_idx, 0.0) + (1.0 / (rrf_k + rank))
        dense_ranks[doc_idx] = rank

    for rank, doc_idx in enumerate(sparse_ranked, start=1):
        accum[doc_idx] = accum.get(doc_idx, 0.0) + (1.0 / (rrf_k + rank))
        sparse_ranks[doc_idx] = rank

    ordered = sorted(accum.items(), key=lambda item: item[1], reverse=True)[:final_k]
    return [
        (doc_idx, score, dense_ranks.get(doc_idx), sparse_ranks.get(doc_idx))
        for doc_idx, score in ordered
    ]
