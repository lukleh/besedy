#!/usr/bin/env python3
"""Phase 1 RAG retrieval evaluation helper.

This script intentionally lives in tests/ to match planning notes and keep
evaluation fixtures near test assets.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from besedy.lib.rag_retrieval import evaluate_phase1_recall


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--questions",
        type=Path,
        required=True,
        help="Path to JSON array of eval records.",
    )
    parser.add_argument("--k", type=int, default=10, help="Recall@k cutoff.")
    parser.add_argument(
        "--index-dir",
        type=Path,
        default=Path("tmp/rag_phase1"),
        help="Phase 1 index directory (default: tmp/rag_phase1).",
    )
    parser.add_argument("--dense-top-k", type=int, default=50)
    parser.add_argument("--sparse-top-k", type=int, default=50)
    parser.add_argument(
        "--reranker-provider",
        choices=["none", "bge-reranker"],
        default="none",
        help="Optional reranker provider for second-stage ranking.",
    )
    parser.add_argument("--reranker-model", default=None)
    parser.add_argument(
        "--rerank-top-n",
        type=int,
        default=0,
        help="Number of fused candidates to rerank (0 disables reranking).",
    )
    parser.add_argument("--reranker-batch-size", type=int, default=8)
    parser.add_argument("--reranker-device", default=None)
    parser.add_argument("--reranker-max-length", type=int, default=512)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    result = evaluate_phase1_recall(
        questions_path=args.questions,
        index_dir=args.index_dir,
        k=args.k,
        dense_top_k=args.dense_top_k,
        sparse_top_k=args.sparse_top_k,
        reranker_provider=args.reranker_provider,
        reranker_model=args.reranker_model,
        rerank_top_n=args.rerank_top_n,
        reranker_batch_size=args.reranker_batch_size,
        reranker_device=args.reranker_device,
        reranker_max_length=args.reranker_max_length,
    )
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("RAG retrieval eval")
        print(f"  total: {result['total']}")
        print(f"  hits: {result['hits']}")
        print(f"  recall@{result['k']}: {result['recall_at_k']:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
