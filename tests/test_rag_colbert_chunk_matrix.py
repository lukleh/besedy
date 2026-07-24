from __future__ import annotations

import json
from pathlib import Path

import pytest

import tests.rag_colbert_chunk_matrix as rag_colbert_chunk_matrix
from besedy.lib.rag_colbert_types import ColbertIndexResult, ColbertTokenAudit
from tests.rag_colbert_chunk_matrix import (
    ChunkMatrixSummary,
    parse_chunk_matrix_spec,
    select_recommended_candidate,
)


def test_parse_chunk_matrix_spec_accepts_colon_form() -> None:
    config = parse_chunk_matrix_spec("180:260:40")

    assert config.min_chunk_tokens == 180
    assert config.max_chunk_tokens == 260
    assert config.overlap_tokens == 40
    assert config.label == "180-260/40"


def test_parse_chunk_matrix_spec_rejects_invalid_order() -> None:
    with pytest.raises(ValueError, match="MIN must be <= MAX"):
        parse_chunk_matrix_spec("260:180:40")


def test_select_recommended_candidate_prefers_fastest_near_best_recall() -> None:
    summaries = [
        ChunkMatrixSummary(
            label="220-300/50",
            min_chunk_tokens=220,
            max_chunk_tokens=300,
            overlap_tokens=50,
            chunk_count=100,
            build_seconds=120.0,
            recall_at_k=0.95,
            benchmark_mean_ms=20.0,
            benchmark_p95_ms=30.0,
            overflow_fraction=0.0,
            overflow_count=0,
            max_tokens=320,
            within_target_fraction=0.9,
            chunk_tokenizer_model="jinaai/jina-colbert-v2",
            index_dir="/tmp/a",
        ),
        ChunkMatrixSummary(
            label="180-260/40",
            min_chunk_tokens=180,
            max_chunk_tokens=260,
            overlap_tokens=40,
            chunk_count=120,
            build_seconds=100.0,
            recall_at_k=0.94,
            benchmark_mean_ms=15.0,
            benchmark_p95_ms=20.0,
            overflow_fraction=0.0,
            overflow_count=0,
            max_tokens=280,
            within_target_fraction=0.92,
            chunk_tokenizer_model="jinaai/jina-colbert-v2",
            index_dir="/tmp/b",
        ),
    ]

    recommended = select_recommended_candidate(summaries, recall_tolerance=0.02)

    assert recommended.label == "180-260/40"


def test_select_recommended_candidate_prefers_overflow_safe_candidate() -> None:
    summaries = [
        ChunkMatrixSummary(
            label="220-300/50",
            min_chunk_tokens=220,
            max_chunk_tokens=300,
            overlap_tokens=50,
            chunk_count=100,
            build_seconds=80.0,
            recall_at_k=0.96,
            benchmark_mean_ms=18.0,
            benchmark_p95_ms=25.0,
            overflow_fraction=0.02,
            overflow_count=2,
            max_tokens=420,
            within_target_fraction=0.91,
            chunk_tokenizer_model="jinaai/jina-colbert-v2",
            index_dir="/tmp/a",
        ),
        ChunkMatrixSummary(
            label="180-260/40",
            min_chunk_tokens=180,
            max_chunk_tokens=260,
            overlap_tokens=40,
            chunk_count=120,
            build_seconds=90.0,
            recall_at_k=0.95,
            benchmark_mean_ms=19.0,
            benchmark_p95_ms=27.0,
            overflow_fraction=0.0,
            overflow_count=0,
            max_tokens=300,
            within_target_fraction=0.94,
            chunk_tokenizer_model="jinaai/jina-colbert-v2",
            index_dir="/tmp/b",
        ),
    ]

    recommended = select_recommended_candidate(summaries, recall_tolerance=0.02)

    assert recommended.label == "180-260/40"


def test_main_json_keeps_stdout_machine_readable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fake_build_colbert_index(**kwargs) -> ColbertIndexResult:
        index_dir = Path(kwargs["index_dir"])
        index_dir.mkdir(parents=True, exist_ok=True)
        (index_dir / "index_meta.json").write_text(
            json.dumps(
                {
                    "chunk_distribution": {
                        "within_target_fraction": 0.99,
                    }
                }
            ),
            encoding="utf-8",
        )
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
            index_bsize=32,
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

    monkeypatch.setattr(rag_colbert_chunk_matrix, "build_colbert_index", fake_build_colbert_index)
    monkeypatch.setattr(
        rag_colbert_chunk_matrix,
        "evaluate_colbert_recall",
        lambda **_kwargs: {"recall_at_k": 1.0},
    )
    monkeypatch.setattr(
        rag_colbert_chunk_matrix,
        "benchmark_colbert_queries",
        lambda **_kwargs: {"summary": {"mean_ms": 10.0, "p95_ms": 12.0}},
    )

    output_dir = tmp_path / "matrix"
    assert (
        rag_colbert_chunk_matrix.main(
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
                "--config",
                "180:260:40",
                "--json",
            ]
        )
        == 0
    )

    captured = capsys.readouterr()
    payload = json.loads(captured.out)

    assert payload["recommendation"]["label"] == "180-260/40"
    assert "Building 180-260/40" not in captured.out
    assert "Phase 1/6: building chunk corpus..." not in captured.out
    assert "Building 180-260/40" in captured.err
    assert "Phase 1/6: building chunk corpus..." in captured.err
