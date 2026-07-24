from __future__ import annotations

import json
from pathlib import Path

import pytest

import besedy.lib.rag_chunk_corpus as rag_chunk_corpus
import besedy.lib.rag_colbert as rag_colbert
from besedy.lib.rag_bundle import default_colbert_active_pointer_path
from besedy.lib.rag_chunk_store import list_chunks
from besedy.lib.rag_colbert import sync_colbert_index
from besedy.lib.rag_colbert_source_state import read_source_state


class WhitespaceTokenCounter:
    model_name = "test-whitespace"

    @staticmethod
    def count_text(text: str) -> int:
        return max(len(text.split()), 1)

    def count_texts(self, texts: list[str]) -> list[int]:
        return [self.count_text(text) for text in texts]


def _write_transcript(
    path: Path, segments: list[dict[str, object]], *, backend: str = "faster-whisper"
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
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


@pytest.fixture
def fake_colbert_worker(monkeypatch: pytest.MonkeyPatch):
    seen_commands: list[tuple[str, dict[str, object]]] = []

    def fake_run_colbert_worker(
        *,
        command: str,
        payload: dict[str, object],
        **_kwargs: object,
    ) -> dict[str, object]:
        seen_commands.append((command, payload))
        if command == "build-index":
            Path(str(payload["colbert_index_dir"])).mkdir(parents=True, exist_ok=True)
            return {
                "token_audit": {
                    "tokenizer_name": "jinaai/jina-colbert-v2",
                    "doc_maxlen": 384,
                    "chunk_count": 1,
                    "max_tokens": 8,
                    "p95_tokens": 8.0,
                    "overflow_count": 0,
                    "overflow_fraction": 0.0,
                }
            }
        if command == "audit-tokens":
            texts = [str(text) for text in payload.get("texts", [])]
            return {
                "tokenizer_name": "jinaai/jina-colbert-v2",
                "doc_maxlen": int(payload.get("doc_maxlen", 384)),
                "chunk_count": len(texts),
                "max_tokens": max((len(text.split()) for text in texts), default=0),
                "p95_tokens": float(max((len(text.split()) for text in texts), default=0)),
                "overflow_count": 0,
                "overflow_fraction": 0.0,
            }
        if command == "add-to-index":
            return {
                "added_chunk_ids": [
                    str(row["chunk_id"]) for row in payload.get("rows", []) if isinstance(row, dict)
                ]
            }
        if command == "delete-from-index":
            return {"deleted_chunk_ids": list(payload.get("chunk_ids", []))}
        raise AssertionError(f"Unexpected worker command: {command}")

    monkeypatch.setattr(
        rag_chunk_corpus,
        "get_chunk_token_counter",
        lambda *args, **kwargs: WhitespaceTokenCounter(),
    )
    monkeypatch.setattr(rag_colbert, "_run_colbert_worker", fake_run_colbert_worker)
    return seen_commands


def test_sync_colbert_index_bootstraps_bundle_and_writes_source_state(
    tmp_path: Path,
    fake_colbert_worker,
) -> None:
    transcripts_root = tmp_path / "transcripts_20260206_120000"
    audio_hash = "a" * 64
    _write_transcript(
        transcripts_root
        / "faster-whisper"
        / "large-v3@silero_vad_v6"
        / audio_hash
        / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "rozpocet a finance"},
            {"start": 1.0, "end": 2.0, "text": "danovy plan dnes"},
        ],
    )

    bundle_dir = tmp_path / "bundle"
    result = sync_colbert_index(
        workflow_group_id="wg-bootstrap",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=bundle_dir,
    )

    assert result.sync_mode == "bootstrap"
    assert result.hashes_added == 1
    rows = read_source_state(bundle_dir / "source_state.sqlite")
    assert sorted(rows) == [audio_hash]
    assert rows[audio_hash].chunk_count == 1


def test_sync_colbert_index_skips_unchanged_scope_without_worker_mutations(
    tmp_path: Path,
    fake_colbert_worker,
) -> None:
    transcripts_root = tmp_path / "transcripts_20260206_120001"
    audio_hash = "b" * 64
    transcript_path = (
        transcripts_root
        / "faster-whisper"
        / "large-v3@silero_vad_v6"
        / audio_hash
        / "transcript.json"
    )
    _write_transcript(
        transcript_path,
        [{"start": 0.0, "end": 1.0, "text": "rozpocet a finance"}],
    )

    bundle_dir = tmp_path / "bundle"
    sync_colbert_index(
        workflow_group_id="wg-unchanged",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=bundle_dir,
    )
    fake_colbert_worker.clear()

    result = sync_colbert_index(
        workflow_group_id="wg-unchanged",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=bundle_dir,
    )

    assert result.sync_mode == "incremental"
    assert result.hashes_unchanged == 1
    assert fake_colbert_worker == []


def test_sync_colbert_index_updates_one_audio_hash_incrementally(
    tmp_path: Path,
    fake_colbert_worker,
) -> None:
    transcripts_root = tmp_path / "transcripts_20260206_120002"
    audio_hash = "c" * 64
    transcript_path = (
        transcripts_root
        / "faster-whisper"
        / "large-v3@silero_vad_v6"
        / audio_hash
        / "transcript.json"
    )
    _write_transcript(
        transcript_path,
        [{"start": 0.0, "end": 1.0, "text": "prvni text"}],
    )

    bundle_dir = tmp_path / "bundle"
    sync_colbert_index(
        workflow_group_id="wg-update",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=bundle_dir,
    )
    original_source_state = read_source_state(bundle_dir / "source_state.sqlite")[audio_hash]
    fake_colbert_worker.clear()

    _write_transcript(
        transcript_path,
        [{"start": 0.0, "end": 1.0, "text": "zmeneny text s vice slovy"}],
    )

    result = sync_colbert_index(
        workflow_group_id="wg-update",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=bundle_dir,
        target_audio_hash=audio_hash,
    )

    commands = [command for command, _payload in fake_colbert_worker]
    assert "delete-from-index" in commands
    assert "add-to-index" in commands
    assert "audit-tokens" in commands
    assert result.hashes_updated == 1
    assert result.chunks_deleted == 1
    assert result.chunks_inserted == 1
    updated_source_state = read_source_state(bundle_dir / "source_state.sqlite")[audio_hash]
    assert (
        updated_source_state.transcript_fingerprint != original_source_state.transcript_fingerprint
    )
    staged_chunks = list_chunks(path=bundle_dir / "chunk_store.sqlite")
    assert staged_chunks[0].text == "zmeneny text s vice slovy"


def test_sync_colbert_index_passes_runtime_override_to_final_token_audit(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus,
        "get_chunk_token_counter",
        lambda *args, **kwargs: WhitespaceTokenCounter(),
    )

    seen_runtimes: list[tuple[str, str | None]] = []

    def fake_run_colbert_worker(
        *,
        command: str,
        payload: dict[str, object],
        runtime_override: str | None = None,
        **_kwargs: object,
    ) -> dict[str, object]:
        seen_runtimes.append((command, runtime_override))
        if command == "build-index":
            Path(str(payload["colbert_index_dir"])).mkdir(parents=True, exist_ok=True)
            return {
                "token_audit": {
                    "tokenizer_name": "jinaai/jina-colbert-v2",
                    "doc_maxlen": 384,
                    "chunk_count": 1,
                    "max_tokens": 2,
                    "p95_tokens": 2.0,
                    "overflow_count": 0,
                    "overflow_fraction": 0.0,
                }
            }
        if command == "audit-tokens":
            texts = [str(text) for text in payload.get("texts", [])]
            return {
                "tokenizer_name": "jinaai/jina-colbert-v2",
                "doc_maxlen": int(payload.get("doc_maxlen", 384)),
                "chunk_count": len(texts),
                "max_tokens": max((len(text.split()) for text in texts), default=0),
                "p95_tokens": float(max((len(text.split()) for text in texts), default=0)),
                "overflow_count": 0,
                "overflow_fraction": 0.0,
            }
        if command == "add-to-index":
            return {"added_chunk_ids": [str(row["chunk_id"]) for row in payload.get("rows", [])]}
        if command == "delete-from-index":
            return {"deleted_chunk_ids": list(payload.get("chunk_ids", []))}
        raise AssertionError(f"Unexpected worker command: {command}")

    monkeypatch.setattr(rag_colbert, "_run_colbert_worker", fake_run_colbert_worker)

    transcripts_root = tmp_path / "transcripts_20260206_120004"
    audio_hash = "e" * 64
    transcript_path = (
        transcripts_root
        / "faster-whisper"
        / "large-v3@silero_vad_v6"
        / audio_hash
        / "transcript.json"
    )
    _write_transcript(
        transcript_path,
        [{"start": 0.0, "end": 1.0, "text": "puvodni text"}],
    )

    bundle_dir = tmp_path / "bundle"
    sync_colbert_index(
        workflow_group_id="wg-runtime",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=bundle_dir,
    )
    seen_runtimes.clear()

    _write_transcript(
        transcript_path,
        [{"start": 0.0, "end": 1.0, "text": "novy text pro audit"}],
    )

    sync_colbert_index(
        workflow_group_id="wg-runtime",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=bundle_dir,
        runtime="docker-indexer",
        target_audio_hash=audio_hash,
    )

    assert seen_runtimes == [
        ("delete-from-index", "docker-indexer"),
        ("add-to-index", "docker-indexer"),
        ("audit-tokens", "docker-indexer"),
    ]


def test_sync_colbert_index_updates_symlink_and_active_pointer_for_default_bundle(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    fake_colbert_worker,
) -> None:
    monkeypatch.setattr(
        "besedy.lib.rag_bundle.DEFAULT_COLBERT_BUNDLE_ROOT", tmp_path / "rag_colbert"
    )
    transcripts_root = tmp_path / "transcripts_20260206_120003"
    audio_hash = "d" * 64
    transcript_path = (
        transcripts_root
        / "faster-whisper"
        / "large-v3@silero_vad_v6"
        / audio_hash
        / "transcript.json"
    )
    _write_transcript(
        transcript_path,
        [{"start": 0.0, "end": 1.0, "text": "puvodni text"}],
    )

    first_result = sync_colbert_index(
        workflow_group_id="wg-default",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
    )
    first_bundle_dir = Path(first_result.index_dir).resolve()
    fake_colbert_worker.clear()

    _write_transcript(
        transcript_path,
        [{"start": 0.0, "end": 1.0, "text": "novy text"}],
    )
    second_result = sync_colbert_index(
        workflow_group_id="wg-default",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        target_audio_hash=audio_hash,
    )

    second_bundle_dir = Path(second_result.index_dir).resolve()
    assert second_bundle_dir != first_bundle_dir

    pointer_path = default_colbert_active_pointer_path(
        workflow_group_id="wg-default",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        colbert_model="jinaai/jina-colbert-v2",
    )
    payload = json.loads(pointer_path.read_text(encoding="utf-8"))
    assert Path(second_result.index_dir).is_symlink()
    assert payload["index_dir"] == str(Path(second_result.index_dir) / "colbert_index")
