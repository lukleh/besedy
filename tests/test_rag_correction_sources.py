from __future__ import annotations

import json
from pathlib import Path

import pytest

import besedy.lib.rag_chunk_corpus as rag_chunk_corpus
from besedy.lib.rag_chunk_corpus import build_chunk_corpus, discover_transcript_sources
from besedy.lib.rag_correction_sources import (
    POINTER_SCHEMA_VERSION,
    load_correction_index_pointers,
    resolve_effective_transcript_sources,
)

CATALOG_ID = "20260101_000000"
HASH_A = "a" * 64
HASH_B = "b" * 64
BACKEND = "faster-whisper/large-v3@silero_vad_v6"


class WhitespaceTokenCounter:
    model_name = "test-whitespace"

    @staticmethod
    def count_text(text: str) -> int:
        return max(len(text.split()), 1)

    def count_texts(self, texts: list[str]) -> list[int]:
        return [self.count_text(text) for text in texts]


def _write_transcript(path: Path, segments: list[dict[str, object]]) -> None:
    payload = {
        "meta": {
            "backend": "faster-whisper",
            "model": "large-v3",
            "audio_filepath": f"/tmp/{path.parent.name}.wav",
            "duration": max((float(seg["end"]) for seg in segments), default=0.0),
            "generation_params": {},
        },
        "segments": segments,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _write_pointer(
    corrections_root: Path,
    *,
    audio_hash: str,
    state: str = "active",
    relative_path: str | None = None,
    schema_version: int = POINTER_SCHEMA_VERSION,
    workflow_group_id: str = CATALOG_ID,
) -> Path:
    workspace_id = "11111111-1111-1111-1111-111111111111"
    publication_id = "22222222-2222-2222-2222-222222222222"
    transcript_rel = relative_path or (
        f"corrections_{CATALOG_ID}/{workspace_id}/publications/{publication_id}/transcript.json"
    )
    pointer_dir = corrections_root / f"corrections_{workflow_group_id}" / "index-sources"
    pointer_dir.mkdir(parents=True, exist_ok=True)
    pointer_path = pointer_dir / f"{audio_hash}.json"
    pointer_path.write_text(
        json.dumps(
            {
                "schema_version": schema_version,
                "workflow_group_id": workflow_group_id,
                "audio_hash": audio_hash,
                "workspace_id": workspace_id,
                "publication_id": publication_id,
                "state": state,
                "backend": BACKEND,
                "transcript_path": transcript_rel,
                "transcript_fingerprint": "f" * 64,
                "updated_at": "2026-09-20T00:00:00.000Z",
            }
        ),
        encoding="utf-8",
    )
    return corrections_root / transcript_rel


@pytest.fixture
def corrections_root(tmp_path: Path) -> Path:
    root = tmp_path / "corrections"
    root.mkdir(parents=True, exist_ok=True)
    return root


def test_pointer_is_ignored_without_its_transcript(corrections_root: Path) -> None:
    _write_pointer(corrections_root, audio_hash=HASH_A)

    pointers = load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root)

    assert pointers == {}


def test_activating_and_active_pointers_both_resolve(corrections_root: Path) -> None:
    for audio_hash, state in ((HASH_A, "activating"), (HASH_B, "active")):
        target = _write_pointer(corrections_root, audio_hash=audio_hash, state=state)
        _write_transcript(target, [{"start": 0.0, "end": 1.0, "text": "corrected"}])

    pointers = load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root)

    assert set(pointers) == {HASH_A, HASH_B}


def test_other_pointer_states_are_ignored(corrections_root: Path) -> None:
    target = _write_pointer(corrections_root, audio_hash=HASH_A, state="failed")
    _write_transcript(target, [{"start": 0.0, "end": 1.0, "text": "corrected"}])

    assert load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root) == {}


def test_unknown_schema_version_is_ignored(corrections_root: Path) -> None:
    target = _write_pointer(corrections_root, audio_hash=HASH_A, schema_version=99)
    _write_transcript(target, [{"start": 0.0, "end": 1.0, "text": "corrected"}])

    assert load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root) == {}


def test_pointer_from_another_catalog_is_ignored(corrections_root: Path) -> None:
    target = _write_pointer(
        corrections_root, audio_hash=HASH_A, workflow_group_id="20260202_000000"
    )
    _write_transcript(target, [{"start": 0.0, "end": 1.0, "text": "corrected"}])

    assert load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root) == {}


def test_pointer_escaping_the_corrections_root_is_ignored(
    corrections_root: Path, tmp_path: Path
) -> None:
    escape = tmp_path / "outside" / "transcript.json"
    _write_transcript(escape, [{"start": 0.0, "end": 1.0, "text": "corrected"}])
    _write_pointer(
        corrections_root,
        audio_hash=HASH_A,
        relative_path="../outside/transcript.json",
    )

    assert load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root) == {}


def test_correction_replaces_the_machine_source_for_its_recording(
    corrections_root: Path, tmp_path: Path
) -> None:
    machine = tmp_path / "machine" / "transcript.json"
    _write_transcript(machine, [{"start": 0.0, "end": 1.0, "text": "machine"}])
    corrected = _write_pointer(corrections_root, audio_hash=HASH_A)
    _write_transcript(corrected, [{"start": 0.0, "end": 1.0, "text": "corrected"}])

    resolved = resolve_effective_transcript_sources(
        workflow_group_id=CATALOG_ID,
        machine_transcripts=[(HASH_A, machine), (HASH_B, machine)],
        corrections_root=corrections_root,
    )

    by_hash = {source.audio_hash: source for source in resolved}
    assert by_hash[HASH_A].origin == "correction"
    assert by_hash[HASH_A].transcript_path == corrected
    assert by_hash[HASH_B].origin == "machine"


def test_correction_is_included_when_the_scope_has_no_machine_transcript(
    corrections_root: Path,
) -> None:
    corrected = _write_pointer(corrections_root, audio_hash=HASH_A)
    _write_transcript(corrected, [{"start": 0.0, "end": 1.0, "text": "corrected"}])

    resolved = resolve_effective_transcript_sources(
        workflow_group_id=CATALOG_ID,
        machine_transcripts=[],
        corrections_root=corrections_root,
    )

    assert [source.audio_hash for source in resolved] == [HASH_A]
    assert resolved[0].origin == "correction"


def test_discovery_and_chunking_use_the_corrected_text(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, corrections_root: Path
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    transcripts_root = tmp_path / "transcripts_20260206_120000"
    workflow, model = BACKEND.split("/")
    _write_transcript(
        transcripts_root / workflow / model / HASH_A / "transcript.json",
        [{"start": 0.0, "end": 2.0, "text": "mis heard machine words"}],
    )
    _write_transcript(
        transcripts_root / workflow / model / HASH_B / "transcript.json",
        [{"start": 0.0, "end": 2.0, "text": "untouched machine words"}],
    )

    corrected = _write_pointer(corrections_root, audio_hash=HASH_A)
    _write_transcript(corrected, [{"start": 0.0, "end": 2.0, "text": "misheard human words"}])

    sources = discover_transcript_sources(
        workflow_group_id=CATALOG_ID,
        backend_key=BACKEND,
        transcripts_root=transcripts_root,
        corrections_root=corrections_root,
    )
    source_paths = {source.audio_hash: source.transcript_path for source in sources.sources}
    assert source_paths[HASH_A] == str(corrected)
    assert HASH_B in source_paths

    corpus = build_chunk_corpus(
        workflow_group_id=CATALOG_ID,
        backend_key=BACKEND,
        transcripts_root=transcripts_root,
        min_chunk_tokens=1,
        max_chunk_tokens=50,
        overlap_tokens=0,
        corrections_root=corrections_root,
    )

    corrected_chunks = [chunk for chunk in corpus.chunks if chunk.audio_hash == HASH_A]
    assert corrected_chunks
    assert all(chunk.backend_key == BACKEND for chunk in corrected_chunks)
    assert "misheard human words" in " ".join(chunk.text for chunk in corrected_chunks)
    assert "mis heard machine words" not in " ".join(chunk.text for chunk in corpus.chunks)


def test_fingerprint_changes_when_correction_replaces_machine_text(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, corrections_root: Path
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    transcripts_root = tmp_path / "transcripts_20260206_120000"
    workflow, model = BACKEND.split("/")
    _write_transcript(
        transcripts_root / workflow / model / HASH_A / "transcript.json",
        [{"start": 0.0, "end": 2.0, "text": "mis heard machine words"}],
    )

    before = discover_transcript_sources(
        workflow_group_id=CATALOG_ID,
        backend_key=BACKEND,
        transcripts_root=transcripts_root,
        corrections_root=corrections_root,
    ).sources[0]

    corrected = _write_pointer(corrections_root, audio_hash=HASH_A)
    _write_transcript(corrected, [{"start": 0.0, "end": 2.0, "text": "misheard human words"}])

    after = discover_transcript_sources(
        workflow_group_id=CATALOG_ID,
        backend_key=BACKEND,
        transcripts_root=transcripts_root,
        corrections_root=corrections_root,
    ).sources[0]

    assert before.audio_hash == after.audio_hash == HASH_A
    assert before.transcript_fingerprint != after.transcript_fingerprint
