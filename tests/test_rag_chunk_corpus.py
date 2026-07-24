from __future__ import annotations

import json
from pathlib import Path

import pytest

import besedy.lib.rag_chunk_corpus as rag_chunk_corpus
from besedy.lib.rag_chunk_corpus import (
    build_chunk_corpus,
    build_chunks_for_transcript,
    discover_transcript_sources,
)


class WhitespaceTokenCounter:
    model_name = "test-whitespace"

    @staticmethod
    def count_text(text: str) -> int:
        return max(len(text.split()), 1)

    def count_texts(self, texts: list[str]) -> list[int]:
        return [self.count_text(text) for text in texts]


def _write_transcript(
    path: Path,
    segments: list[dict[str, object]],
    *,
    backend: str = "faster-whisper",
    meta_overrides: dict[str, object] | None = None,
) -> None:
    payload = {
        "meta": {
            "backend": backend,
            "model": "large-v3",
            "audio_filepath": f"/tmp/{path.parent.name}.wav",
            "duration": max((float(seg["end"]) for seg in segments), default=0.0),
            "generation_params": {},
        },
        "segments": segments,
    }
    if meta_overrides:
        payload["meta"].update(meta_overrides)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_build_chunk_corpus_matches_per_transcript_chunk_builds(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    transcripts_root = tmp_path / "transcripts_20260206_120000"
    backend_dir = transcripts_root / "faster-whisper" / "large-v3@silero_vad_v6"
    transcript1 = backend_dir / ("a" * 64) / "transcript.json"
    transcript2 = backend_dir / ("b" * 64) / "transcript.json"
    _write_transcript(
        transcript1,
        [
            {"start": 0.0, "end": 2.0, "text": "alpha beta gamma"},
            {"start": 2.0, "end": 4.0, "text": "delta epsilon zeta"},
        ],
    )
    _write_transcript(
        transcript2,
        [
            {"start": 0.0, "end": 2.0, "text": "eta theta iota"},
            {"start": 2.0, "end": 4.0, "text": "kappa lambda mu"},
        ],
    )

    corpus = build_chunk_corpus(
        workflow_group_id="wg-123",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
    )

    transcript1_chunks, transcript1_windows = build_chunks_for_transcript(
        transcript_path=transcript1,
        transcripts_root=transcripts_root,
        workflow_group_id="wg-123",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        run_id="20260206_120000",
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
    )
    transcript2_chunks, transcript2_windows = build_chunks_for_transcript(
        transcript_path=transcript2,
        transcripts_root=transcripts_root,
        workflow_group_id="wg-123",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        run_id="20260206_120000",
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
    )

    expected_chunks = sorted(
        [*transcript1_chunks, *transcript2_chunks],
        key=lambda chunk: chunk.chunk_id,
    )

    assert [chunk.chunk_id for chunk in corpus.chunks] == [
        chunk.chunk_id for chunk in expected_chunks
    ]
    assert [chunk.text for chunk in corpus.chunks] == [chunk.text for chunk in expected_chunks]
    assert corpus.transcripts_skipped == 0
    assert corpus.chunk_distribution.chunk_count == len(transcript1_windows) + len(
        transcript2_windows
    )


def test_build_chunk_corpus_reports_distribution(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    transcripts_root = tmp_path / "transcripts_20260206_120001"
    backend_dir = transcripts_root / "faster-whisper" / "large-v3@silero_vad_v6"
    _write_transcript(
        backend_dir / ("c" * 64) / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "jedna dve tri"},
            {"start": 1.0, "end": 2.0, "text": "ctyri pet sest"},
        ],
    )
    _write_transcript(
        backend_dir / ("d" * 64) / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "sedm osm devet"},
            {"start": 1.0, "end": 2.0, "text": "deset jedenact dvanact"},
        ],
    )

    corpus = build_chunk_corpus(
        workflow_group_id="wg-124",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
    )

    assert corpus.run_id == "20260206_120001"
    assert corpus.transcript_files == 2
    assert corpus.transcripts_skipped == 0
    assert corpus.chunk_distribution.tokenizer_model == "test-whitespace"
    assert corpus.chunk_distribution.chunk_count == len(corpus.chunks)
    assert corpus.chunk_distribution.within_target_count == len(corpus.chunks)


def test_build_chunk_corpus_assigns_chunk_ordinals_per_audio_hash(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    transcripts_root = tmp_path / "transcripts_20260206_120005"
    backend_dir = transcripts_root / "faster-whisper" / "large-v3@silero_vad_v6"
    _write_transcript(
        backend_dir / ("e" * 64) / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "alpha beta gamma"},
            {"start": 1.0, "end": 2.0, "text": "delta epsilon zeta"},
            {"start": 2.0, "end": 3.0, "text": "eta theta iota"},
        ],
    )
    _write_transcript(
        backend_dir / ("f" * 64) / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "jedna dve tri"},
            {"start": 1.0, "end": 2.0, "text": "ctyri pet sest"},
            {"start": 2.0, "end": 3.0, "text": "sedm osm devet"},
        ],
    )

    corpus = build_chunk_corpus(
        workflow_group_id="wg-126",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        min_chunk_tokens=2,
        max_chunk_tokens=4,
        overlap_tokens=1,
    )

    ordinals_by_audio: dict[str, list[int | None]] = {}
    for chunk in corpus.chunks:
        ordinals_by_audio.setdefault(chunk.audio_hash, []).append(chunk.chunk_ordinal)

    assert sorted(ordinals_by_audio["e" * 64]) == list(range(len(ordinals_by_audio["e" * 64])))
    assert sorted(ordinals_by_audio["f" * 64]) == list(range(len(ordinals_by_audio["f" * 64])))


def test_build_chunk_corpus_resolves_explicit_transcripts_container(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    transcripts_container = tmp_path / "text-data" / "transcripts"
    transcripts_container.mkdir(parents=True)
    run_root = transcripts_container / "transcripts_20260206_120010"
    backend_dir = run_root / "faster-whisper" / "large-v3@silero_vad_v6"
    _write_transcript(
        backend_dir / ("e" * 64) / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "rozpocet a dane"},
            {"start": 1.0, "end": 2.0, "text": "plan a vydaje"},
        ],
    )
    (transcripts_container / "transcripts").symlink_to(run_root)

    corpus = build_chunk_corpus(
        workflow_group_id="wg-125",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_container,
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
    )

    assert corpus.run_id == "20260206_120010"
    assert corpus.transcripts_root == str(run_root)
    assert len(corpus.chunks) == 1


def test_build_chunk_corpus_uses_explicit_chunk_tokenizer_model(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    seen_model_names: list[str | None] = []

    def fake_get_chunk_token_counter(*, model_name: str = "default"):
        seen_model_names.append(model_name)
        return WhitespaceTokenCounter()

    monkeypatch.setattr(rag_chunk_corpus, "get_chunk_token_counter", fake_get_chunk_token_counter)

    transcripts_root = tmp_path / "transcripts_20260206_120011"
    backend_dir = transcripts_root / "faster-whisper" / "large-v3@silero_vad_v6"
    _write_transcript(
        backend_dir / ("f" * 64) / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "rozpocet a dane"},
            {"start": 1.0, "end": 2.0, "text": "plan a vydaje"},
        ],
    )

    corpus = build_chunk_corpus(
        workflow_group_id="wg-127",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
        chunk_tokenizer_model="acme/custom-tokenizer",
    )

    assert seen_model_names == ["acme/custom-tokenizer"]
    assert corpus.chunk_distribution.tokenizer_model == "test-whitespace"


def test_discover_transcript_sources_rejects_duplicate_canonical_audio_hashes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    transcripts_root = tmp_path / "transcripts_20260206_120012"
    backend_dir = transcripts_root / "faster-whisper" / "large-v3@silero_vad_v6"
    canonical_audio_hash = "a" * 64
    common_meta = {
        "audio_hash": canonical_audio_hash,
        "audio_filepath": f"/tmp/{canonical_audio_hash}.wav",
    }
    _write_transcript(
        backend_dir / "legacy-a" / "transcript.json",
        [{"start": 0.0, "end": 1.0, "text": "alpha beta gamma"}],
        meta_overrides=common_meta,
    )
    _write_transcript(
        backend_dir / "legacy-b" / "transcript.json",
        [{"start": 0.0, "end": 1.0, "text": "delta epsilon zeta"}],
        meta_overrides=common_meta,
    )

    with pytest.raises(ValueError, match="same canonical audio hash"):
        discover_transcript_sources(
            workflow_group_id="wg-128",
            backend_key="faster-whisper/large-v3@silero_vad_v6",
            transcripts_root=transcripts_root,
        )


def test_build_chunk_corpus_rejects_duplicate_canonical_audio_hashes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    transcripts_root = tmp_path / "transcripts_20260206_120013"
    backend_dir = transcripts_root / "faster-whisper" / "large-v3@silero_vad_v6"
    canonical_audio_hash = "b" * 64
    common_meta = {
        "audio_hash": canonical_audio_hash,
        "audio_filepath": f"/tmp/{canonical_audio_hash}.wav",
    }
    _write_transcript(
        backend_dir / "legacy-c" / "transcript.json",
        [{"start": 0.0, "end": 1.0, "text": "jedna dve tri"}],
        meta_overrides=common_meta,
    )
    _write_transcript(
        backend_dir / "legacy-d" / "transcript.json",
        [{"start": 0.0, "end": 1.0, "text": "ctyri pet sest"}],
        meta_overrides=common_meta,
    )

    with pytest.raises(ValueError, match="same canonical audio hash"):
        build_chunk_corpus(
            workflow_group_id="wg-129",
            backend_key="faster-whisper/large-v3@silero_vad_v6",
            transcripts_root=transcripts_root,
            min_chunk_tokens=2,
            max_chunk_tokens=4,
            overlap_tokens=1,
        )
