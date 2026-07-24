from __future__ import annotations

import json
from pathlib import Path

import pytest

import tests.rag_colbert_eval as rag_colbert_eval
from besedy.lib.rag_colbert_types import ColbertQueryHit, ColbertQueryResult


def _write_index_meta(index_dir: Path) -> None:
    index_dir.mkdir()
    (index_dir / "index_meta.json").write_text(
        json.dumps(
            {
                "workflow_group_id": "wg-123",
                "backend_key": "faster-whisper/large-v3@silero_vad_v6",
                "run_id": "20260206_120000",
                "chunk_version": "v2",
                "colbert_model": "jinaai/jina-colbert-v2",
                "doc_maxlen": 384,
            }
        ),
        encoding="utf-8",
    )


def test_colbert_eval_rejects_stale_chunk_targets(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    questions_path = tmp_path / "questions.json"
    questions_path.write_text(
        json.dumps(
            [
                {
                    "id": "q1",
                    "question": "kde se mluvi o rozpoctu",
                    "targets": [{"chunk_id": "missing-chunk"}],
                }
            ]
        ),
        encoding="utf-8",
    )

    index_dir = tmp_path / "rag_colbert"
    _write_index_meta(index_dir)
    (index_dir / "chunk_manifest.jsonl").write_text(
        json.dumps(
            {
                "chunk_id": "chunk-1",
                "audio_hash": "a" * 64,
                "start_sec": 0.0,
                "end_sec": 1.0,
                "text": "rozpocet",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(
        rag_colbert_eval,
        "query_colbert_index",
        lambda **_kwargs: pytest.fail("stale target validation should run before querying"),
    )

    with pytest.raises(
        ValueError, match="Chunk-target eval set does not match the current ColBERT index"
    ):
        rag_colbert_eval.evaluate_colbert_recall(
            questions_path=questions_path,
            index_dir=index_dir,
            k=5,
        )


def test_colbert_eval_reports_oblique_span_and_audio_only_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audio_a = "a" * 64
    audio_b = "b" * 64
    questions_path = tmp_path / "oblique.json"
    questions_path.write_text(
        json.dumps(
            [
                {
                    "id": "oblique-1",
                    "query": "find the implicit acceptance distinction",
                    "category": "implicit_theme",
                    "targets": [
                        {
                            "audio_hash": audio_a,
                            "start_seconds": 10.0,
                            "end_seconds": 20.0,
                        }
                    ],
                },
                {
                    "id": "known-1",
                    "question": "known lexical target",
                    "targets": [{"audio_hash": audio_b}],
                },
                {
                    "id": "oblique-miss",
                    "query": "find a latent behavior change",
                    "targets": [
                        {
                            "audio_hash": audio_a,
                            "start_seconds": 80.0,
                            "end_seconds": 90.0,
                        }
                    ],
                },
            ]
        ),
        encoding="utf-8",
    )

    index_dir = tmp_path / "rag_colbert"
    _write_index_meta(index_dir)
    query_ks: list[int] = []

    def hit(
        *,
        rank: int,
        chunk_id: str,
        audio_hash: str,
        start_sec: float,
        end_sec: float,
    ) -> ColbertQueryHit:
        return ColbertQueryHit(
            rank=rank,
            chunk_id=chunk_id,
            audio_hash=audio_hash,
            start_sec=start_sec,
            end_sec=end_sec,
            text=f"text for {chunk_id}",
            score=100.0 - rank,
        )

    def fake_query_colbert_index(**kwargs: object) -> ColbertQueryResult:
        query_ks.append(int(kwargs["k"]))
        query = str(kwargs["query"])
        if query == "find the implicit acceptance distinction":
            hits = [
                hit(
                    rank=1,
                    chunk_id="a-early",
                    audio_hash=audio_a,
                    start_sec=0.0,
                    end_sec=5.0,
                ),
                hit(
                    rank=2,
                    chunk_id="other",
                    audio_hash="c" * 64,
                    start_sec=0.0,
                    end_sec=5.0,
                ),
                hit(
                    rank=3,
                    chunk_id="a-target",
                    audio_hash=audio_a,
                    start_sec=12.0,
                    end_sec=18.0,
                ),
            ]
        elif query == "known lexical target":
            hits = [
                hit(
                    rank=1,
                    chunk_id="b-target",
                    audio_hash=audio_b,
                    start_sec=0.0,
                    end_sec=5.0,
                )
            ]
        else:
            hits = [
                hit(
                    rank=1,
                    chunk_id="a-wrong-window",
                    audio_hash=audio_a,
                    start_sec=0.0,
                    end_sec=5.0,
                )
            ]
        return ColbertQueryResult(
            query=query,
            index_dir=str(index_dir),
            workflow_group_id="wg-123",
            backend_key="faster-whisper/large-v3@silero_vad_v6",
            run_id="20260206_120000",
            chunk_version="v2",
            colbert_model="jinaai/jina-colbert-v2",
            doc_maxlen=384,
            hits=hits,
        )

    monkeypatch.setattr(rag_colbert_eval, "query_colbert_index", fake_query_colbert_index)

    result = rag_colbert_eval.evaluate_colbert_recall(
        questions_path=questions_path,
        index_dir=index_dir,
        k=2,
        cutoffs=[1, 3],
        include_hit_details=True,
    )

    assert result["total"] == 3
    assert result["audio_total"] == 3
    assert result["k"] == 2
    assert result["cutoffs"] == [1, 2, 3]
    assert result["recall_at_k"] == pytest.approx(1 / 3)
    metrics = {entry["cutoff"]: entry for entry in result["metrics_at_cutoff"]}
    assert metrics[1]["recall"] == pytest.approx(1 / 3)
    assert metrics[3]["recall"] == pytest.approx(2 / 3)
    assert metrics[1]["audio_recall"] == pytest.approx(1.0)
    assert metrics[3]["mrr"] == pytest.approx((1 / 3 + 1) / 3)
    assert metrics[1]["audio_only_misses"] == 2
    assert metrics[2]["audio_only_misses"] == 2
    assert metrics[3]["audio_only_misses"] == 1
    assert result["audio_only_misses"] == 2
    assert query_ks == [3, 3, 3]
    assert result["details"][0]["matched"] is False
    assert result["details"][0]["audio_only_miss"] is True
    assert result["details"][0]["match_rank"] == 3
    assert result["details"][0]["audio_match_rank"] == 1
    assert result["details"][0]["returned_hits"][0]["text"] == "text for a-early"
    round_tripped = json.loads(json.dumps(result))
    assert round_tripped["metrics_at_cutoff"][0]["cutoff"] == 1


def test_colbert_eval_audio_recall_excludes_chunk_only_targets(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audio_hash = "a" * 64
    questions_path = tmp_path / "mixed-targets.json"
    questions_path.write_text(
        json.dumps(
            [
                {
                    "id": "chunk-only",
                    "question": "find the known chunk",
                    "targets": [{"chunk_id": "chunk-target"}],
                },
                {
                    "id": "audio-target",
                    "question": "find the known recording",
                    "targets": [{"audio_hash": audio_hash}],
                },
            ]
        ),
        encoding="utf-8",
    )
    index_dir = tmp_path / "rag_colbert"
    _write_index_meta(index_dir)
    (index_dir / "chunk_manifest.jsonl").write_text(
        json.dumps(
            {
                "chunk_id": "chunk-target",
                "audio_hash": "b" * 64,
                "start_sec": 0.0,
                "end_sec": 5.0,
                "text": "matching text",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    def fake_query_colbert_index(**kwargs: object) -> ColbertQueryResult:
        query = str(kwargs["query"])
        chunk_id = "chunk-target" if query == "find the known chunk" else "audio-target"
        hit_audio_hash = "b" * 64 if query == "find the known chunk" else audio_hash
        return ColbertQueryResult(
            query=query,
            index_dir=str(index_dir),
            workflow_group_id="wg-123",
            backend_key="faster-whisper/large-v3@silero_vad_v6",
            run_id="20260206_120000",
            chunk_version="v2",
            colbert_model="jinaai/jina-colbert-v2",
            doc_maxlen=384,
            hits=[
                ColbertQueryHit(
                    rank=1,
                    chunk_id=chunk_id,
                    audio_hash=hit_audio_hash,
                    start_sec=0.0,
                    end_sec=5.0,
                    text="matching text",
                    score=1.0,
                )
            ],
        )

    monkeypatch.setattr(rag_colbert_eval, "query_colbert_index", fake_query_colbert_index)

    result = rag_colbert_eval.evaluate_colbert_recall(
        questions_path=questions_path,
        index_dir=index_dir,
        k=1,
    )

    assert result["total"] == 2
    assert result["audio_total"] == 1
    assert result["recall_at_k"] == 1.0
    assert result["metrics_at_cutoff"][0]["audio_recall"] == 1.0


def test_colbert_eval_cli_rejects_non_positive_cutoff(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exc_info:
        rag_colbert_eval.main(
            [
                "--questions",
                "questions.json",
                "--index-dir",
                "index",
                "--cutoffs",
                "0",
            ]
        )

    assert exc_info.value.code == 2
    assert "must be a positive integer" in capsys.readouterr().err
