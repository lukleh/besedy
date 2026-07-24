"""Tests for phase-1 RAG ingestion and retrieval."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

import besedy.lib.rag_retrieval as rag_retrieval
from besedy.lib.rag_retrieval import (
    SegmentUnit,
    chunk_segments,
    evaluate_phase1_recall,
    ingest_phase1_index,
    normalize_backend_key,
    query_phase1_index,
)
from besedy.lib.rag_retrieval_chunking import measure_chunk_texts, split_segments_for_chunking
from besedy.lib.rag_retrieval_types import QueryHit, QueryResult


class WhitespaceTokenCounter:
    model_name = "test-whitespace"

    @staticmethod
    def count_text(text: str) -> int:
        return max(len(text.split()), 1)

    def count_texts(self, texts: list[str]) -> list[int]:
        return [self.count_text(text) for text in texts]


def _write_transcript(path: Path, segments: list[dict], *, backend: str = "faster-whisper") -> None:
    payload = {
        "meta": {
            "backend": backend,
            "model": "large-v3",
            "audio_filepath": f"/tmp/{path.parent.name}.wav",
            "duration": max((seg["end"] for seg in segments), default=0.0),
            "generation_params": {},
        },
        "segments": segments,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_normalize_backend_key_three_part() -> None:
    assert normalize_backend_key("faster-whisper/large-v3/silero_vad_v6") == (
        "faster-whisper/large-v3@silero_vad_v6"
    )


def test_chunk_segments_overlap_strategy() -> None:
    segments = [
        SegmentUnit(
            start=float(i * 10), end=float(i * 10 + 9), text=("slovo " * 80).strip(), token_count=80
        )
        for i in range(8)
    ]
    windows = chunk_segments(
        segments,
        token_counter=WhitespaceTokenCounter(),
        min_tokens=220,
        max_tokens=300,
        overlap_tokens=50,
    )

    assert len(windows) >= 2
    first = windows[0]
    second = windows[1]

    # With 80-token segments and 220-300 target, first window should contain 3 segments.
    assert first.start_index == 0
    assert first.end_index == 3
    assert 220 <= first.token_count <= 300

    # 50-token overlap should step back by at least one segment (80 tokens).
    assert second.start_index == 2
    assert second.start_index < first.end_index


def test_measure_chunk_texts_reports_target_band() -> None:
    distribution = measure_chunk_texts(
        [
            ("slovo " * 230).strip(),
            ("slovo " * 310).strip(),
            ("slovo " * 180).strip(),
        ],
        token_counter=WhitespaceTokenCounter(),
        min_tokens=220,
        max_tokens=300,
        overflow_single_segment_count=1,
    )

    assert distribution.tokenizer_model == "test-whitespace"
    assert distribution.chunk_count == 3
    assert distribution.within_target_count == 1
    assert distribution.above_target_count == 1
    assert distribution.below_target_count == 1
    assert distribution.overflow_single_segment_count == 1


def test_split_segments_for_chunking_preserves_timeline() -> None:
    text = (
        (("alpha " * 45).strip() + ". ")
        + (("beta " * 45).strip() + ". ")
        + (("gamma " * 45).strip())
    )
    segments = [
        SegmentUnit(
            start=10.0,
            end=40.0,
            text=text,
            token_count=WhitespaceTokenCounter().count_text(text),
        )
    ]

    split_segments = split_segments_for_chunking(
        segments,
        token_counter=WhitespaceTokenCounter(),
        max_segment_tokens=60,
    )

    assert len(split_segments) == 3
    assert split_segments[0].start == 10.0
    assert split_segments[-1].end == 40.0
    assert all(segment.token_count <= 60 for segment in split_segments)
    assert all(
        earlier.end <= later.start for earlier, later in zip(split_segments, split_segments[1:])
    )


def test_ingest_query_and_eval_roundtrip(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(rag_retrieval, "get_chunk_token_counter", lambda: WhitespaceTokenCounter())

    run_root = tmp_path / "transcripts_20260206_120000"
    backend_dir = run_root / "faster-whisper" / "large-v3@silero_vad_v6"
    hash1 = "a" * 64
    hash2 = "b" * 64

    _write_transcript(
        backend_dir / hash1 / "transcript.json",
        [
            {"start": 0.0, "end": 2.0, "text": "alpha tema rozpocet alpha"},
            {"start": 2.1, "end": 4.0, "text": "diskuze o rozpoctu a nakladech"},
        ],
    )
    _write_transcript(
        backend_dir / hash2 / "transcript.json",
        [
            {"start": 0.0, "end": 2.0, "text": "beta sport hokej"},
            {"start": 2.1, "end": 4.0, "text": "zapasy a vysledky"},
        ],
    )

    index_dir = tmp_path / "rag_index"
    ingest_result = ingest_phase1_index(
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=run_root,
        index_dir=index_dir,
        embedding_provider="hash",
        min_chunk_tokens=2,
        max_chunk_tokens=8,
        overlap_tokens=1,
    )

    assert ingest_result.transcript_files == 2
    assert ingest_result.transcripts_skipped == 0
    assert ingest_result.chunks_indexed > 0
    assert ingest_result.chunk_distribution is not None
    assert ingest_result.chunk_distribution.tokenizer_model == "test-whitespace"
    assert (index_dir / "index_meta.json").exists()
    assert (index_dir / "chunks.jsonl").exists()
    assert (index_dir / "embeddings.npy").exists()
    assert (index_dir / "bm25_index.json").exists()
    index_meta = json.loads((index_dir / "index_meta.json").read_text(encoding="utf-8"))
    assert index_meta["chunking"]["tokenizer_model"] == "test-whitespace"
    assert index_meta["chunk_distribution"]["chunk_count"] == ingest_result.chunks_indexed

    # Idempotent rebuild should keep the same chunk count (upsert semantics).
    ingest_result2 = ingest_phase1_index(
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=run_root,
        index_dir=index_dir,
        embedding_provider="hash",
        min_chunk_tokens=2,
        max_chunk_tokens=8,
        overlap_tokens=1,
    )
    assert ingest_result2.chunks_indexed == ingest_result.chunks_indexed

    query_result = query_phase1_index(
        query="rozpocet",
        index_dir=index_dir,
        dense_top_k=20,
        sparse_top_k=20,
        final_k=5,
    )
    assert query_result.hits
    assert query_result.hits[0].audio_hash == hash1

    questions_path = tmp_path / "questions.json"
    questions_path.write_text(
        json.dumps(
            [
                {
                    "id": "q1",
                    "question": "Kde se mluvi o rozpoctu?",
                    "targets": [{"audio_hash": hash1}],
                },
                {
                    "id": "q2",
                    "question": "Kde se mluvi o hokeji?",
                    "targets": [{"audio_hash": hash2}],
                },
            ]
        ),
        encoding="utf-8",
    )

    eval_result = evaluate_phase1_recall(
        questions_path=questions_path,
        index_dir=index_dir,
        k=5,
        dense_top_k=20,
        sparse_top_k=20,
    )
    assert eval_result["total"] == 2
    assert eval_result["hits"] == 2
    assert eval_result["recall_at_k"] == 1.0


def test_phase1_eval_accepts_oblique_query_and_time_aliases(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audio_hash = "a" * 64
    questions_path = tmp_path / "oblique.json"
    questions_path.write_text(
        json.dumps(
            [
                {
                    "id": "oblique-1",
                    "query": "find the target moment",
                    "targets": [
                        {
                            "audio_hash": audio_hash,
                            "start_seconds": 10,
                            "end_seconds": 20,
                        }
                    ],
                }
            ]
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        rag_retrieval,
        "query_phase1_index",
        lambda **kwargs: QueryResult(
            query=str(kwargs["query"]),
            backend_key="backend",
            run_id="run",
            hits=[
                QueryHit(
                    rank=1,
                    chunk_id="wrong-window",
                    score=1.0,
                    dense_rank=1,
                    sparse_rank=None,
                    audio_hash=audio_hash,
                    backend_key="backend",
                    start=0,
                    end=5,
                    text="same recording, wrong evidence",
                )
            ],
        ),
    )

    result = evaluate_phase1_recall(
        questions_path=questions_path,
        index_dir=tmp_path / "unused-index",
        k=1,
    )

    assert result["total"] == 1
    assert result["hits"] == 0
    assert result["details"][0]["question"] == "find the target moment"


def test_query_reranker_reorders_hits(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(rag_retrieval, "get_chunk_token_counter", lambda: WhitespaceTokenCounter())

    run_root = tmp_path / "transcripts_20260206_120001"
    backend_dir = run_root / "faster-whisper" / "large-v3@silero_vad_v6"
    hash1 = "c" * 64
    hash2 = "d" * 64

    _write_transcript(
        backend_dir / hash1 / "transcript.json",
        [
            {"start": 0.0, "end": 2.0, "text": "tema jedna rozpocet"},
            {"start": 2.1, "end": 4.0, "text": "finance a vydaje"},
        ],
    )
    _write_transcript(
        backend_dir / hash2 / "transcript.json",
        [
            {"start": 0.0, "end": 2.0, "text": "tema dva sport hokej"},
            {"start": 2.1, "end": 4.0, "text": "vysledky zapasu"},
        ],
    )

    index_dir = tmp_path / "rag_index_rerank"
    ingest_phase1_index(
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=run_root,
        index_dir=index_dir,
        embedding_provider="hash",
        min_chunk_tokens=2,
        max_chunk_tokens=8,
        overlap_tokens=1,
    )

    baseline = query_phase1_index(
        query="tema",
        index_dir=index_dir,
        dense_top_k=20,
        sparse_top_k=20,
        final_k=2,
    )
    assert len(baseline.hits) == 2

    class DummyReranker:
        name = "dummy"
        model = "dummy-v1"

        @staticmethod
        def score(*, query: str, texts: list[str]) -> np.ndarray:
            del query
            # Increasing score means later candidate should become higher rank.
            return np.array([float(i) for i in range(len(texts))], dtype=np.float32)

    monkeypatch.setattr(rag_retrieval, "_make_reranker_provider", lambda **kwargs: DummyReranker())

    reranked = query_phase1_index(
        query="tema",
        index_dir=index_dir,
        dense_top_k=20,
        sparse_top_k=20,
        final_k=2,
        reranker_provider="bge-reranker",
        rerank_top_n=2,
    )
    assert len(reranked.hits) == 2
    assert reranked.hits[0].chunk_id == baseline.hits[1].chunk_id
    assert reranked.hits[0].rerank_score is not None
    assert reranked.hits[0].fused_score is not None
