"""Tests for the transcript chunking helpers used by the ColBERT index."""

from __future__ import annotations

import sys
import types

import pytest

import besedy.lib.rag_retrieval_chunking as rag_retrieval_chunking
from besedy.lib.rag_retrieval_chunking import (
    chunk_segments,
    measure_chunk_texts,
    normalize_backend_key,
    split_segments_for_chunking,
)
from besedy.lib.rag_retrieval_types import SegmentUnit


class WhitespaceTokenCounter:
    model_name = "test-whitespace"

    @staticmethod
    def count_text(text: str) -> int:
        return max(len(text.split()), 1)

    def count_texts(self, texts: list[str]) -> list[int]:
        return [self.count_text(text) for text in texts]


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


def test_load_chunk_tokenizer_refuses_remote_code(monkeypatch: pytest.MonkeyPatch) -> None:
    """The host-side chunk tokenizer must never block on the remote-code prompt.

    Models like jinaai/jina-colbert-v2 carry custom code in their config; with
    ``trust_remote_code`` unset transformers asks on stdin whether to run it and
    hangs the pipeline when run from a terminal. Chunk sizing only needs the
    vocabulary, so the loader refuses remote code explicitly.
    """

    calls: list[tuple[tuple, dict]] = []

    class FakeAutoTokenizer:
        @staticmethod
        def from_pretrained(*args, **kwargs):
            calls.append((args, kwargs))
            return "tokenizer"

    fake_transformers = types.ModuleType("transformers")
    fake_transformers.AutoTokenizer = FakeAutoTokenizer  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "transformers", fake_transformers)

    loaded = rag_retrieval_chunking._load_chunk_tokenizer.__wrapped__("jinaai/jina-colbert-v2")

    assert loaded == "tokenizer"
    assert calls == [(("jinaai/jina-colbert-v2",), {"use_fast": True, "trust_remote_code": False})]


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
