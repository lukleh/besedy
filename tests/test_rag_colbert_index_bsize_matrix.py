from __future__ import annotations

import json
from pathlib import Path

import pytest

import tests.rag_colbert_index_bsize_matrix as rag_colbert_index_bsize_matrix
from besedy.lib.rag_colbert_types import ColbertIndexResult, ColbertTokenAudit
from tests.rag_colbert_index_bsize_matrix import (
    IndexBsizeSummary,
    select_recommended_candidate,
)


def test_select_recommended_candidate_prefers_fastest_build_when_quality_is_equivalent() -> None:
    summaries = [
        IndexBsizeSummary(
            label="index_bsize=32",
            index_bsize=32,
            chunk_count=100,
            build_seconds=100.0,
            recall_at_k=1.0,
            benchmark_mean_ms=20.0,
            benchmark_p95_ms=30.0,
            peak_vram_mib=9000,
            baseline_vram_mib=0,
            peak_vram_delta_mib=9000,
            overflow_fraction=0.0,
            overflow_count=0,
            max_tokens=320,
            index_dir="/tmp/a",
        ),
        IndexBsizeSummary(
            label="index_bsize=16",
            index_bsize=16,
            chunk_count=100,
            build_seconds=120.0,
            recall_at_k=1.0,
            benchmark_mean_ms=20.0,
            benchmark_p95_ms=32.0,
            peak_vram_mib=7000,
            baseline_vram_mib=0,
            peak_vram_delta_mib=7000,
            overflow_fraction=0.0,
            overflow_count=0,
            max_tokens=320,
            index_dir="/tmp/b",
        ),
    ]

    recommended = select_recommended_candidate(summaries)

    assert recommended.index_bsize == 32


def test_select_recommended_candidate_respects_recall_floor() -> None:
    summaries = [
        IndexBsizeSummary(
            label="index_bsize=32",
            index_bsize=32,
            chunk_count=100,
            build_seconds=100.0,
            recall_at_k=1.0,
            benchmark_mean_ms=20.0,
            benchmark_p95_ms=30.0,
            peak_vram_mib=9000,
            baseline_vram_mib=0,
            peak_vram_delta_mib=9000,
            overflow_fraction=0.0,
            overflow_count=0,
            max_tokens=320,
            index_dir="/tmp/a",
        ),
        IndexBsizeSummary(
            label="index_bsize=16",
            index_bsize=16,
            chunk_count=100,
            build_seconds=80.0,
            recall_at_k=0.9,
            benchmark_mean_ms=19.0,
            benchmark_p95_ms=28.0,
            peak_vram_mib=7000,
            baseline_vram_mib=0,
            peak_vram_delta_mib=7000,
            overflow_fraction=0.0,
            overflow_count=0,
            max_tokens=320,
            index_dir="/tmp/b",
        ),
    ]

    recommended = select_recommended_candidate(summaries, recall_tolerance=0.0)

    assert recommended.index_bsize == 32


def test_main_json_keeps_stdout_machine_readable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fake_build_colbert_index(**kwargs) -> ColbertIndexResult:
        index_dir = Path(kwargs["index_dir"])
        index_dir.mkdir(parents=True, exist_ok=True)
        progress_callback = kwargs.get("progress_callback")
        if progress_callback is not None:
            progress_callback("Phase 1/6: building chunk corpus...")
        return ColbertIndexResult(
            index_dir=str(index_dir),
            workflow_group_id="wg-123",
            backend_key="faster-whisper/large-v3@silero_vad_v6",
            run_id="20260403_120000",
            chunk_version="v2",
            min_chunk_tokens=180,
            max_chunk_tokens=260,
            overlap_tokens=40,
            colbert_model="jinaai/jina-colbert-v2",
            doc_maxlen=384,
            index_bsize=int(kwargs["index_bsize"]),
            split_documents=False,
            use_faiss=False,
            chunk_count=1,
            token_audit=ColbertTokenAudit(
                tokenizer_name="jinaai/jina-colbert-v2",
                doc_maxlen=384,
                chunk_count=1,
                max_tokens=200,
                p95_tokens=200.0,
                overflow_count=0,
                overflow_fraction=0.0,
            ),
        )

    class FakeSampler:
        def __init__(self, *, poll_interval_seconds: float = 0.5) -> None:
            del poll_interval_seconds
            self.baseline_mib = 100
            self.peak_mib = 900

        def __enter__(self) -> FakeSampler:
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

    monkeypatch.setattr(
        rag_colbert_index_bsize_matrix, "build_colbert_index", fake_build_colbert_index
    )
    monkeypatch.setattr(rag_colbert_index_bsize_matrix, "PeakGpuMemorySampler", FakeSampler)
    monkeypatch.setattr(
        rag_colbert_index_bsize_matrix,
        "evaluate_colbert_recall",
        lambda **_kwargs: {"recall_at_k": 1.0},
    )
    monkeypatch.setattr(
        rag_colbert_index_bsize_matrix,
        "benchmark_colbert_queries",
        lambda **_kwargs: {"summary": {"mean_ms": 10.0, "p95_ms": 12.0}},
    )

    output_dir = tmp_path / "matrix"
    assert (
        rag_colbert_index_bsize_matrix.main(
            [
                "--workflow-group-id",
                "wg-123",
                "--backend-key",
                "faster-whisper/large-v3@silero_vad_v6",
                "--transcripts-root",
                str(tmp_path),
                "--output-dir",
                str(output_dir),
                "--eval-questions",
                str(tmp_path / "eval.json"),
                "--benchmark-questions",
                str(tmp_path / "benchmark.json"),
                "--index-bsize",
                "16",
                "--json",
            ]
        )
        == 0
    )

    captured = capsys.readouterr()
    payload = json.loads(captured.out)

    assert payload["recommendation"]["index_bsize"] == 16
    assert payload["summaries"][0]["peak_vram_delta_mib"] == 800
    assert "Building index_bsize=16" not in captured.out
    assert "Phase 1/6: building chunk corpus..." not in captured.out
    assert "Building index_bsize=16" in captured.err
    assert "Phase 1/6: building chunk corpus..." in captured.err


def test_main_rejects_removed_isolated_runtime_aliases(
    tmp_path: Path,
) -> None:
    with pytest.raises(SystemExit):
        rag_colbert_index_bsize_matrix.main(
            [
                "--workflow-group-id",
                "wg-123",
                "--backend-key",
                "faster-whisper/large-v3@silero_vad_v6",
                "--transcripts-root",
                str(tmp_path),
                "--output-dir",
                str(tmp_path / "matrix"),
                "--eval-questions",
                str(tmp_path / "eval.json"),
                "--benchmark-questions",
                str(tmp_path / "benchmark.json"),
                "--build-runtime",
                "isolated",
            ]
        )
