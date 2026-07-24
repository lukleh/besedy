#!/usr/bin/env python3
"""Build and compare a small ColBERT index_bsize matrix."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterator

from besedy.lib.rag_colbert import (
    COLBERT_RUNTIME_CHOICES,
    COLBERT_RUNTIME_DOCKER,
    COLBERT_RUNTIME_DOCKER_INDEXER,
    COLBERT_RUNTIME_ENV_VAR,
    DEFAULT_COLBERT_MODEL,
    DEFAULT_DOC_MAXLEN,
    DEFAULT_INDEX_BSIZE,
    DEFAULT_MAX_CHUNK_TOKENS,
    DEFAULT_MIN_CHUNK_TOKENS,
    DEFAULT_OVERLAP_TOKENS,
    build_colbert_index,
)
from tests.rag_colbert_benchmark import benchmark_colbert_queries
from tests.rag_colbert_eval import evaluate_colbert_recall

DEFAULT_INDEX_BSIZE_MATRIX = (DEFAULT_INDEX_BSIZE, 16, 8)


def _emit_progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


@dataclass(frozen=True)
class IndexBsizeSummary:
    label: str
    index_bsize: int
    chunk_count: int
    build_seconds: float
    recall_at_k: float
    benchmark_mean_ms: float
    benchmark_p95_ms: float
    peak_vram_mib: int | None
    baseline_vram_mib: int | None
    peak_vram_delta_mib: int | None
    overflow_fraction: float
    overflow_count: int
    max_tokens: int
    index_dir: str


def select_recommended_candidate(
    summaries: list[IndexBsizeSummary],
    *,
    recall_tolerance: float = 0.0,
    benchmark_p95_tolerance_ms: float = 25.0,
) -> IndexBsizeSummary:
    if not summaries:
        raise ValueError("At least one index_bsize summary is required.")
    if recall_tolerance < 0:
        raise ValueError("recall_tolerance must be >= 0.")
    if benchmark_p95_tolerance_ms < 0:
        raise ValueError("benchmark_p95_tolerance_ms must be >= 0.")

    best_recall = max(summary.recall_at_k for summary in summaries)
    recall_floor = best_recall - recall_tolerance
    recall_candidates = [summary for summary in summaries if summary.recall_at_k >= recall_floor]

    best_p95 = min(summary.benchmark_p95_ms for summary in recall_candidates)
    p95_ceiling = best_p95 + benchmark_p95_tolerance_ms
    latency_candidates = [
        summary for summary in recall_candidates if summary.benchmark_p95_ms <= p95_ceiling
    ]

    return min(
        latency_candidates,
        key=lambda summary: (
            summary.build_seconds,
            summary.benchmark_p95_ms,
            -(summary.index_bsize),
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


def _read_gpu_memory_used_mib() -> list[int]:
    result = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=memory.used",
            "--format=csv,noheader,nounits",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "nvidia-smi failed"
        raise RuntimeError(f"Unable to read GPU memory with nvidia-smi: {message}")

    values: list[int] = []
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        values.append(int(stripped))
    return values


class PeakGpuMemorySampler:
    def __init__(self, *, poll_interval_seconds: float = 0.5) -> None:
        if poll_interval_seconds <= 0:
            raise ValueError("poll_interval_seconds must be positive.")
        self._poll_interval_seconds = poll_interval_seconds
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._errors: list[BaseException] = []
        self.baseline_mib: int | None = None
        self.peak_mib: int | None = None

    def _sample_once(self) -> None:
        values = _read_gpu_memory_used_mib()
        current = max(values) if values else 0
        if self.baseline_mib is None:
            self.baseline_mib = current
        if self.peak_mib is None or current > self.peak_mib:
            self.peak_mib = current

    def _run(self) -> None:
        try:
            self._sample_once()
            while not self._stop_event.wait(self._poll_interval_seconds):
                self._sample_once()
        except BaseException as exc:  # pragma: no cover - surfaced after join
            self._errors.append(exc)

    def __enter__(self) -> PeakGpuMemorySampler:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=max(1.0, self._poll_interval_seconds * 4))
        if self._errors:
            raise RuntimeError("GPU memory sampler failed.") from self._errors[0]


def _build_output_dir(base_output_dir: Path, *, index_bsize: int) -> Path:
    return base_output_dir / f"index_bsize_{index_bsize}"


def run_index_bsize_matrix(
    *,
    workflow_group_id: str,
    backend_key: str,
    transcripts_root: Path,
    output_dir: Path,
    index_bsizes: list[int],
    eval_questions_path: Path,
    benchmark_questions_path: Path,
    colbert_model: str = DEFAULT_COLBERT_MODEL,
    chunk_tokenizer_model: str | None = None,
    doc_maxlen: int = DEFAULT_DOC_MAXLEN,
    min_chunk_tokens: int = DEFAULT_MIN_CHUNK_TOKENS,
    max_chunk_tokens: int = DEFAULT_MAX_CHUNK_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
    use_faiss: bool = False,
    build_runtime: str | None = None,
    query_runtime: str | None = None,
    k: int = 10,
    benchmark_runs: int = 2,
    benchmark_warmup_runs: int = 1,
    force_fast: bool = False,
    overwrite: bool = False,
    gpu_poll_interval_seconds: float = 0.5,
) -> dict[str, Any]:
    if not index_bsizes:
        raise ValueError("At least one index_bsize value is required.")

    output_dir.mkdir(parents=True, exist_ok=True)
    summaries: list[IndexBsizeSummary] = []
    results: list[dict[str, Any]] = []

    for index, index_bsize in enumerate(index_bsizes, start=1):
        if index_bsize <= 0:
            raise ValueError("index_bsize values must be positive.")

        candidate_dir = _build_output_dir(output_dir, index_bsize=index_bsize)
        _emit_progress(
            f"[{index}/{len(index_bsizes)}] Building index_bsize={index_bsize} -> {candidate_dir}"
        )
        build_started_at = time.perf_counter()
        with PeakGpuMemorySampler(poll_interval_seconds=gpu_poll_interval_seconds) as sampler:
            result = build_colbert_index(
                workflow_group_id=workflow_group_id,
                backend_key=backend_key,
                transcripts_root=transcripts_root,
                index_dir=candidate_dir,
                colbert_model=colbert_model,
                chunk_tokenizer_model=chunk_tokenizer_model,
                doc_maxlen=doc_maxlen,
                index_bsize=index_bsize,
                use_faiss=use_faiss,
                overwrite=overwrite,
                min_chunk_tokens=min_chunk_tokens,
                max_chunk_tokens=max_chunk_tokens,
                overlap_tokens=overlap_tokens,
                runtime=build_runtime,
                progress_callback=(
                    lambda message, current_bsize=index_bsize: _emit_progress(
                        f"[index_bsize={current_bsize}] {message}"
                    )
                ),
            )
        build_seconds = time.perf_counter() - build_started_at

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

        peak_vram_delta_mib = None
        if sampler.peak_mib is not None and sampler.baseline_mib is not None:
            peak_vram_delta_mib = max(0, sampler.peak_mib - sampler.baseline_mib)

        summary = IndexBsizeSummary(
            label=f"index_bsize={index_bsize}",
            index_bsize=index_bsize,
            chunk_count=int(result.chunk_count),
            build_seconds=round(build_seconds, 3),
            recall_at_k=float(recall["recall_at_k"]),
            benchmark_mean_ms=float(benchmark["summary"]["mean_ms"]),
            benchmark_p95_ms=float(benchmark["summary"]["p95_ms"]),
            peak_vram_mib=sampler.peak_mib,
            baseline_vram_mib=sampler.baseline_mib,
            peak_vram_delta_mib=peak_vram_delta_mib,
            overflow_fraction=float(result.token_audit.overflow_fraction),
            overflow_count=int(result.token_audit.overflow_count),
            max_tokens=int(result.token_audit.max_tokens),
            index_dir=str(candidate_dir),
        )
        summaries.append(summary)
        results.append(
            {
                "summary": asdict(summary),
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
        "min_chunk_tokens": min_chunk_tokens,
        "max_chunk_tokens": max_chunk_tokens,
        "overlap_tokens": overlap_tokens,
        "use_faiss": use_faiss,
        "build_runtime": build_runtime,
        "query_runtime": query_runtime,
        "k": k,
        "benchmark_runs": benchmark_runs,
        "benchmark_warmup_runs": benchmark_warmup_runs,
        "force_fast": force_fast,
        "gpu_poll_interval_seconds": gpu_poll_interval_seconds,
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
        "--index-bsize",
        action="append",
        dest="index_bsizes",
        type=int,
        default=None,
        help="Repeat to override the default matrix (32, 16, 8).",
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
    parser.add_argument("--min-chunk-tokens", type=int, default=DEFAULT_MIN_CHUNK_TOKENS)
    parser.add_argument("--max-chunk-tokens", type=int, default=DEFAULT_MAX_CHUNK_TOKENS)
    parser.add_argument("--overlap-tokens", type=int, default=DEFAULT_OVERLAP_TOKENS)
    parser.add_argument("--use-faiss", action="store_true")
    parser.add_argument(
        "--build-runtime",
        choices=COLBERT_RUNTIME_CHOICES,
        default=COLBERT_RUNTIME_DOCKER_INDEXER,
    )
    parser.add_argument(
        "--query-runtime",
        choices=COLBERT_RUNTIME_CHOICES,
        default=COLBERT_RUNTIME_DOCKER,
    )
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--benchmark-runs", type=int, default=2)
    parser.add_argument("--benchmark-warmup-runs", type=int, default=1)
    parser.add_argument("--force-fast", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--gpu-poll-interval-seconds", type=float, default=0.5)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    index_bsizes = args.index_bsizes or list(DEFAULT_INDEX_BSIZE_MATRIX)
    payload = run_index_bsize_matrix(
        workflow_group_id=args.workflow_group_id,
        backend_key=args.backend_key,
        transcripts_root=args.transcripts_root,
        output_dir=args.output_dir,
        index_bsizes=index_bsizes,
        eval_questions_path=args.eval_questions,
        benchmark_questions_path=args.benchmark_questions,
        colbert_model=args.model,
        chunk_tokenizer_model=args.chunk_tokenizer_model,
        doc_maxlen=args.doc_maxlen,
        min_chunk_tokens=args.min_chunk_tokens,
        max_chunk_tokens=args.max_chunk_tokens,
        overlap_tokens=args.overlap_tokens,
        use_faiss=args.use_faiss,
        build_runtime=args.build_runtime,
        query_runtime=args.query_runtime,
        k=args.k,
        benchmark_runs=args.benchmark_runs,
        benchmark_warmup_runs=args.benchmark_warmup_runs,
        force_fast=args.force_fast,
        overwrite=args.overwrite,
        gpu_poll_interval_seconds=args.gpu_poll_interval_seconds,
    )

    results_path = args.output_dir / "results.json"
    results_path.parent.mkdir(parents=True, exist_ok=True)
    results_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    print("ColBERT index_bsize matrix")
    print(f"  workflow_group_id: {payload['workflow_group_id']}")
    print(f"  backend_key: {payload['backend_key']}")
    print(f"  output_dir: {payload['output_dir']}")
    print(f"  results_json: {results_path}")
    print("")
    for summary in payload["summaries"]:
        peak_vram = summary["peak_vram_mib"]
        peak_delta = summary["peak_vram_delta_mib"]
        peak_text = "n/a" if peak_vram is None else str(peak_vram)
        delta_text = "n/a" if peak_delta is None else str(peak_delta)
        print(
            "  "
            f"index_bsize={summary['index_bsize']}: recall@{payload['k']}={summary['recall_at_k']:.4f}, "
            f"p95_ms={summary['benchmark_p95_ms']:.2f}, "
            f"build_s={summary['build_seconds']:.2f}, "
            f"peak_vram_mib={peak_text}, "
            f"peak_delta_mib={delta_text}, "
            f"chunks={summary['chunk_count']}"
        )
    recommendation = payload["recommendation"]
    print("")
    print(
        "Recommended default: "
        f"index_bsize={recommendation['index_bsize']} "
        f"(recall@{payload['k']}={recommendation['recall_at_k']:.4f}, "
        f"p95_ms={recommendation['benchmark_p95_ms']:.2f}, "
        f"build_s={recommendation['build_seconds']:.2f}, "
        f"peak_delta_mib={recommendation['peak_vram_delta_mib'] if recommendation['peak_vram_delta_mib'] is not None else 'n/a'})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
