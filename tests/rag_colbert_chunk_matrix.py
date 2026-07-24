#!/usr/bin/env python3
"""Build and compare a small ColBERT chunk-size matrix."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterator

from besedy.lib.rag_colbert import (
    COLBERT_RUNTIME_CHOICES,
    COLBERT_RUNTIME_ENV_VAR,
    DEFAULT_COLBERT_MODEL,
    DEFAULT_DOC_MAXLEN,
    build_colbert_index,
)
from tests.rag_colbert_benchmark import benchmark_colbert_queries
from tests.rag_colbert_eval import evaluate_colbert_recall

DEFAULT_MATRIX_SPECS = ("220:300:50", "180:260:40", "160:240:40")


def _emit_progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


@dataclass(frozen=True)
class ChunkMatrixConfig:
    min_chunk_tokens: int
    max_chunk_tokens: int
    overlap_tokens: int

    @property
    def label(self) -> str:
        return f"{self.min_chunk_tokens}-{self.max_chunk_tokens}/{self.overlap_tokens}"


@dataclass(frozen=True)
class ChunkMatrixSummary:
    label: str
    min_chunk_tokens: int
    max_chunk_tokens: int
    overlap_tokens: int
    chunk_count: int
    build_seconds: float
    recall_at_k: float
    benchmark_mean_ms: float
    benchmark_p95_ms: float
    overflow_fraction: float
    overflow_count: int
    max_tokens: int
    within_target_fraction: float
    chunk_tokenizer_model: str
    index_dir: str


def parse_chunk_matrix_spec(raw: str) -> ChunkMatrixConfig:
    normalized = raw.strip()
    if not normalized:
        raise ValueError("Chunk matrix spec must not be empty.")

    for separator in (":", ",", "/"):
        if separator in normalized:
            parts = [part.strip() for part in normalized.split(separator)]
            if len(parts) == 3:
                break
    else:
        raise ValueError(
            f"Invalid chunk matrix spec: {raw!r}. Expected MIN:MAX:OVERLAP, for example 180:260:40."
        )

    try:
        min_chunk_tokens, max_chunk_tokens, overlap_tokens = (int(part) for part in parts)
    except ValueError as exc:
        raise ValueError(f"Invalid chunk matrix spec: {raw!r}. Values must be integers.") from exc

    if min_chunk_tokens <= 0 or max_chunk_tokens <= 0 or overlap_tokens < 0:
        raise ValueError(f"Invalid chunk matrix spec: {raw!r}. Values must be positive.")
    if min_chunk_tokens > max_chunk_tokens:
        raise ValueError(f"Invalid chunk matrix spec: {raw!r}. MIN must be <= MAX.")

    return ChunkMatrixConfig(
        min_chunk_tokens=min_chunk_tokens,
        max_chunk_tokens=max_chunk_tokens,
        overlap_tokens=overlap_tokens,
    )


def select_recommended_candidate(
    summaries: list[ChunkMatrixSummary],
    *,
    recall_tolerance: float = 0.02,
    max_overflow_fraction: float = 0.001,
) -> ChunkMatrixSummary:
    if not summaries:
        raise ValueError("At least one chunk-matrix summary is required.")
    if recall_tolerance < 0:
        raise ValueError("recall_tolerance must be >= 0.")
    if max_overflow_fraction < 0:
        raise ValueError("max_overflow_fraction must be >= 0.")

    overflow_ok = [
        summary for summary in summaries if summary.overflow_fraction <= max_overflow_fraction
    ]
    candidate_pool = overflow_ok or list(summaries)
    best_recall = max(summary.recall_at_k for summary in candidate_pool)
    recall_floor = best_recall - recall_tolerance
    near_best = [summary for summary in candidate_pool if summary.recall_at_k >= recall_floor]
    return min(
        near_best,
        key=lambda summary: (
            summary.benchmark_p95_ms,
            summary.build_seconds,
            summary.chunk_count,
            summary.max_chunk_tokens,
            summary.min_chunk_tokens,
        ),
    )


@contextmanager
def colbert_runtime_override(runtime: str | None) -> Iterator[None]:
    original = os.environ.get(COLBERT_RUNTIME_ENV_VAR)
    if runtime is None:
        yield
        return

    os.environ[COLBERT_RUNTIME_ENV_VAR] = runtime
    try:
        yield
    finally:
        if original is None:
            os.environ.pop(COLBERT_RUNTIME_ENV_VAR, None)
        else:
            os.environ[COLBERT_RUNTIME_ENV_VAR] = original


def _load_index_meta(index_dir: Path) -> dict[str, Any]:
    return json.loads((index_dir / "index_meta.json").read_text(encoding="utf-8"))


def _build_output_dir(base_output_dir: Path, config: ChunkMatrixConfig) -> Path:
    return base_output_dir / config.label.replace("/", "_")


def run_chunk_matrix(
    *,
    workflow_group_id: str,
    backend_key: str,
    transcripts_root: Path,
    output_dir: Path,
    configs: list[ChunkMatrixConfig],
    eval_questions_path: Path,
    benchmark_questions_path: Path,
    colbert_model: str = DEFAULT_COLBERT_MODEL,
    chunk_tokenizer_model: str | None = None,
    doc_maxlen: int = DEFAULT_DOC_MAXLEN,
    use_faiss: bool = False,
    build_runtime: str | None = None,
    query_runtime: str | None = None,
    k: int = 10,
    benchmark_runs: int = 2,
    benchmark_warmup_runs: int = 1,
    force_fast: bool = False,
    overwrite: bool = False,
) -> dict[str, Any]:
    if not configs:
        raise ValueError("At least one chunk matrix config is required.")

    output_dir.mkdir(parents=True, exist_ok=True)
    summaries: list[ChunkMatrixSummary] = []
    results: list[dict[str, Any]] = []

    for index, config in enumerate(configs, start=1):
        candidate_dir = _build_output_dir(output_dir, config)
        _emit_progress(f"[{index}/{len(configs)}] Building {config.label} -> {candidate_dir}")
        build_started_at = time.perf_counter()
        result = build_colbert_index(
            workflow_group_id=workflow_group_id,
            backend_key=backend_key,
            transcripts_root=transcripts_root,
            index_dir=candidate_dir,
            colbert_model=colbert_model,
            chunk_tokenizer_model=chunk_tokenizer_model,
            doc_maxlen=doc_maxlen,
            use_faiss=use_faiss,
            overwrite=overwrite,
            min_chunk_tokens=config.min_chunk_tokens,
            max_chunk_tokens=config.max_chunk_tokens,
            overlap_tokens=config.overlap_tokens,
            runtime=build_runtime,
            progress_callback=lambda message, label=config.label: _emit_progress(
                f"[{label}] {message}"
            ),
        )
        build_seconds = time.perf_counter() - build_started_at
        index_meta = _load_index_meta(candidate_dir)

        with colbert_runtime_override(query_runtime):
            recall = evaluate_colbert_recall(
                questions_path=eval_questions_path,
                index_dir=candidate_dir,
                k=k,
                force_fast=force_fast,
            )
            benchmark = benchmark_colbert_queries(
                questions_path=benchmark_questions_path,
                index_dir=candidate_dir,
                k=k,
                force_fast=force_fast,
                runs=benchmark_runs,
                warmup_runs=benchmark_warmup_runs,
            )

        summary = ChunkMatrixSummary(
            label=config.label,
            min_chunk_tokens=config.min_chunk_tokens,
            max_chunk_tokens=config.max_chunk_tokens,
            overlap_tokens=config.overlap_tokens,
            chunk_count=int(result.chunk_count),
            build_seconds=round(build_seconds, 3),
            recall_at_k=float(recall["recall_at_k"]),
            benchmark_mean_ms=float(benchmark["summary"]["mean_ms"]),
            benchmark_p95_ms=float(benchmark["summary"]["p95_ms"]),
            overflow_fraction=float(result.token_audit.overflow_fraction),
            overflow_count=int(result.token_audit.overflow_count),
            max_tokens=int(result.token_audit.max_tokens),
            within_target_fraction=float(
                index_meta["chunk_distribution"]["within_target_fraction"]
            ),
            chunk_tokenizer_model=str(
                index_meta.get("chunk_tokenizer_model")
                or result.chunk_tokenizer_model
                or colbert_model
            ),
            index_dir=str(candidate_dir),
        )
        summaries.append(summary)
        results.append(
            {
                "config": asdict(config),
                "summary": asdict(summary),
                "index_meta": index_meta,
                "build_result": json.loads(json.dumps(asdict(result))),
                "recall": recall,
                "benchmark": benchmark,
            }
        )

    recommendation = select_recommended_candidate(summaries)
    return {
        "workflow_group_id": workflow_group_id,
        "backend_key": backend_key,
        "transcripts_root": str(transcripts_root),
        "output_dir": str(output_dir),
        "colbert_model": colbert_model,
        "chunk_tokenizer_model": chunk_tokenizer_model or colbert_model,
        "doc_maxlen": doc_maxlen,
        "use_faiss": use_faiss,
        "build_runtime": build_runtime,
        "query_runtime": query_runtime,
        "k": k,
        "benchmark_runs": benchmark_runs,
        "benchmark_warmup_runs": benchmark_warmup_runs,
        "force_fast": force_fast,
        "summaries": [asdict(summary) for summary in summaries],
        "recommendation": asdict(recommendation),
        "results": results,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workflow-group-id", required=True)
    parser.add_argument("--backend-key", required=True)
    parser.add_argument("--transcripts-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--config",
        action="append",
        dest="configs",
        default=None,
        help=("Chunk config in MIN:MAX:OVERLAP form. Repeat to override the default matrix."),
    )
    parser.add_argument("--eval-questions", type=Path, required=True)
    parser.add_argument("--benchmark-questions", type=Path, required=True)
    parser.add_argument("--model", default=DEFAULT_COLBERT_MODEL)
    parser.add_argument(
        "--chunk-tokenizer-model",
        default=None,
        help="Optional explicit tokenizer model for chunk sizing. Default: use the ColBERT model.",
    )
    parser.add_argument("--doc-maxlen", type=int, default=DEFAULT_DOC_MAXLEN)
    parser.add_argument("--use-faiss", action="store_true")
    parser.add_argument("--build-runtime", choices=COLBERT_RUNTIME_CHOICES, default=None)
    parser.add_argument("--query-runtime", choices=COLBERT_RUNTIME_CHOICES, default=None)
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--benchmark-runs", type=int, default=2)
    parser.add_argument("--benchmark-warmup-runs", type=int, default=1)
    parser.add_argument("--force-fast", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    config_specs = args.configs or list(DEFAULT_MATRIX_SPECS)
    configs = [parse_chunk_matrix_spec(raw) for raw in config_specs]
    payload = run_chunk_matrix(
        workflow_group_id=args.workflow_group_id,
        backend_key=args.backend_key,
        transcripts_root=args.transcripts_root,
        output_dir=args.output_dir,
        configs=configs,
        eval_questions_path=args.eval_questions,
        benchmark_questions_path=args.benchmark_questions,
        colbert_model=args.model,
        chunk_tokenizer_model=args.chunk_tokenizer_model,
        doc_maxlen=args.doc_maxlen,
        use_faiss=args.use_faiss,
        build_runtime=args.build_runtime,
        query_runtime=args.query_runtime,
        k=args.k,
        benchmark_runs=args.benchmark_runs,
        benchmark_warmup_runs=args.benchmark_warmup_runs,
        force_fast=args.force_fast,
        overwrite=args.overwrite,
    )

    results_path = args.output_dir / "results.json"
    results_path.parent.mkdir(parents=True, exist_ok=True)
    results_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    print("ColBERT chunk matrix")
    print(f"  workflow_group_id: {payload['workflow_group_id']}")
    print(f"  backend_key: {payload['backend_key']}")
    print(f"  output_dir: {payload['output_dir']}")
    print(f"  results_json: {results_path}")
    print("")
    for summary in payload["summaries"]:
        print(
            "  "
            f"{summary['label']}: recall@{payload['k']}={summary['recall_at_k']:.4f}, "
            f"p95_ms={summary['benchmark_p95_ms']:.2f}, "
            f"build_s={summary['build_seconds']:.2f}, "
            f"overflow={summary['overflow_count']} ({summary['overflow_fraction']:.2%}), "
            f"chunks={summary['chunk_count']}"
        )
    recommendation = payload["recommendation"]
    print("")
    print(
        "Recommended default: "
        f"{recommendation['label']} "
        f"(recall@{payload['k']}={recommendation['recall_at_k']:.4f}, "
        f"p95_ms={recommendation['benchmark_p95_ms']:.2f}, "
        f"build_s={recommendation['build_seconds']:.2f})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
