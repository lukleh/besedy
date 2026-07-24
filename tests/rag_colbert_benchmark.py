#!/usr/bin/env python3
"""Benchmark sequential ColBERT retrieval latency over a fixed question set."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from besedy.lib.rag_colbert import query_colbert_index
from tests._rag_benchmark_support import duration_stats, load_question_records


def benchmark_colbert_queries(
    *,
    questions_path: Path | str,
    index_dir: Path | str,
    k: int = 10,
    force_fast: bool = False,
    runs: int = 1,
    warmup_runs: int = 0,
) -> dict[str, Any]:
    """Benchmark sequential ColBERT retrieval latency over a fixed question set."""

    if runs <= 0:
        raise ValueError("runs must be positive.")
    if warmup_runs < 0:
        raise ValueError("warmup_runs must be >= 0.")

    records = load_question_records(questions_path)
    index_meta = json.loads((Path(index_dir) / "index_meta.json").read_text(encoding="utf-8"))

    for _ in range(warmup_runs):
        for record in records:
            query_colbert_index(
                query=str(record["question"]).strip(),
                index_dir=index_dir,
                k=k,
                force_fast=force_fast,
            )

    samples: list[dict[str, Any]] = []
    for run_index in range(runs):
        for record in records:
            question = str(record["question"]).strip()
            started_at = time.perf_counter()
            result = query_colbert_index(
                query=question, index_dir=index_dir, k=k, force_fast=force_fast
            )
            duration_ms = (time.perf_counter() - started_at) * 1000
            samples.append(
                {
                    "run": run_index + 1,
                    "id": record.get("id"),
                    "question": question,
                    "duration_ms": round(duration_ms, 3),
                    "result_count": len(result.hits),
                    "top_audio_hash": result.hits[0].audio_hash if result.hits else None,
                    "top_chunk_id": result.hits[0].chunk_id if result.hits else None,
                }
            )

    durations = [float(sample["duration_ms"]) for sample in samples]
    by_question: dict[str, list[float]] = {}
    for sample in samples:
        key = str(sample["id"] or sample["question"])
        by_question.setdefault(key, []).append(float(sample["duration_ms"]))

    per_question = [
        {"id": key, **duration_stats(values), "calls": len(values)}
        for key, values in sorted(by_question.items())
    ]

    return {
        "mode": "colbert_only",
        "workflow_group_id": str(index_meta["workflow_group_id"]),
        "backend_key": str(index_meta["backend_key"]),
        "index_dir": str(index_dir),
        "colbert_model": str(index_meta["colbert_model"]),
        "doc_maxlen": int(index_meta["doc_maxlen"]),
        "chunk_version": str(index_meta["chunk_version"]),
        "run_id": str(index_meta["run_id"]),
        "questions_path": str(questions_path),
        "question_count": len(records),
        "runs": runs,
        "warmup_runs": warmup_runs,
        "total_calls": len(samples),
        "k": k,
        "force_fast": force_fast,
        "summary": duration_stats(durations),
        "per_question": per_question,
        "samples": samples,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--questions", type=Path, required=True, help="Path to JSON eval records.")
    parser.add_argument(
        "--index-dir", type=Path, required=True, help="ColBERT sidecar index directory."
    )
    parser.add_argument("--k", type=int, default=10, help="Result cutoff.")
    parser.add_argument(
        "--force-fast", action="store_true", help="Forward force_fast to ColBERT search."
    )
    parser.add_argument(
        "--runs", type=int, default=1, help="Number of timed passes over the question set."
    )
    parser.add_argument(
        "--warmup-runs", type=int, default=0, help="Number of warmup passes to ignore."
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    result = benchmark_colbert_queries(
        questions_path=args.questions,
        index_dir=args.index_dir,
        k=args.k,
        force_fast=args.force_fast,
        runs=args.runs,
        warmup_runs=args.warmup_runs,
    )
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        summary = result["summary"]
        print("ColBERT latency benchmark")
        print(f"  workflow_group_id: {result['workflow_group_id']}")
        print(f"  backend_key: {result['backend_key']}")
        print(f"  questions: {result['question_count']}")
        print(f"  runs: {result['runs']}")
        print(f"  total_calls: {result['total_calls']}")
        print(f"  force_fast: {result['force_fast']}")
        print(f"  mean_ms: {summary['mean_ms']:.2f}")
        print(f"  median_ms: {summary['median_ms']:.2f}")
        print(f"  p95_ms: {summary['p95_ms']:.2f}")
        print(f"  max_ms: {summary['max_ms']:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
