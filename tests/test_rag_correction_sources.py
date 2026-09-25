from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

import besedy.lib.rag_chunk_corpus as rag_chunk_corpus
from besedy.lib.rag_chunk_corpus import build_chunk_corpus, discover_transcript_sources
from besedy.lib.rag_correction_sources import (
    POINTER_SCHEMA_VERSION,
    CorrectionPointerError,
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


def _publish_correction(
    corrections_root: Path,
    *,
    audio_hash: str,
    segments: list[dict[str, object]] | None = None,
    state: str = "active",
    schema_version: int = POINTER_SCHEMA_VERSION,
    workflow_group_id: str = CATALOG_ID,
    corrupt: bool = False,
) -> Path:
    """Write a corrected transcript and a pointer that carries its real hash.

    The hash has to be the file's own, because the indexer verifies it: a
    fixture with an invented hash would be rejected, which is the point of
    verifying it at all.
    """
    target = _write_pointer(
        corrections_root,
        audio_hash=audio_hash,
        state=state,
        schema_version=schema_version,
        workflow_group_id=workflow_group_id,
    )
    _write_transcript(target, segments or [{"start": 0.0, "end": 1.0, "text": "corrected"}])

    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    pointer_path = (
        corrections_root
        / f"corrections_{workflow_group_id}"
        / "index-sources"
        / f"{audio_hash}.json"
    )
    payload = json.loads(pointer_path.read_text(encoding="utf-8"))
    payload["artifact_sha256"] = "0" * 64 if corrupt else digest
    pointer_path.write_text(json.dumps(payload), encoding="utf-8")
    return target


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
                "artifact_sha256": "f" * 64,
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


# A pointer that exists but cannot be honoured stops the build. Skipping it
# would fall back to the machine transcript and silently replace corrected
# chunks while the reader still serves the publication.


def test_pointer_without_its_transcript_stops_the_build(corrections_root: Path) -> None:
    _write_pointer(corrections_root, audio_hash=HASH_A)

    with pytest.raises(CorrectionPointerError, match="cannot be read"):
        load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root)


def test_no_pointer_directory_means_no_corrections(corrections_root: Path) -> None:
    assert load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root) == {}


def test_activating_and_active_pointers_both_resolve(corrections_root: Path) -> None:
    for audio_hash, state in ((HASH_A, "activating"), (HASH_B, "active")):
        _publish_correction(corrections_root, audio_hash=audio_hash, state=state)

    pointers = load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root)

    assert set(pointers) == {HASH_A, HASH_B}


def test_other_pointer_states_stop_the_build(corrections_root: Path) -> None:
    target = _write_pointer(corrections_root, audio_hash=HASH_A, state="failed")
    _write_transcript(target, [{"start": 0.0, "end": 1.0, "text": "corrected"}])

    with pytest.raises(CorrectionPointerError, match="unknown state"):
        load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root)


def test_unknown_schema_version_stops_the_build(corrections_root: Path) -> None:
    target = _write_pointer(corrections_root, audio_hash=HASH_A, schema_version=99)
    _write_transcript(target, [{"start": 0.0, "end": 1.0, "text": "corrected"}])

    with pytest.raises(CorrectionPointerError, match="schema_version"):
        load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root)


def test_pointer_from_another_catalog_stops_the_build(corrections_root: Path) -> None:
    target = _write_pointer(
        corrections_root, audio_hash=HASH_A, workflow_group_id="20260202_000000"
    )
    _write_transcript(target, [{"start": 0.0, "end": 1.0, "text": "corrected"}])
    # Filed under this catalog's directory, but claiming another one.
    other = corrections_root / "corrections_20260202_000000" / "index-sources" / f"{HASH_A}.json"
    mine = corrections_root / f"corrections_{CATALOG_ID}" / "index-sources" / f"{HASH_A}.json"
    mine.parent.mkdir(parents=True, exist_ok=True)
    mine.write_text(other.read_text(encoding="utf-8"), encoding="utf-8")

    with pytest.raises(CorrectionPointerError, match="belongs to catalog"):
        load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root)


def test_pointer_escaping_the_corrections_root_stops_the_build(
    corrections_root: Path, tmp_path: Path
) -> None:
    escape = tmp_path / "outside" / "transcript.json"
    _write_transcript(escape, [{"start": 0.0, "end": 1.0, "text": "corrected"}])
    _write_pointer(
        corrections_root,
        audio_hash=HASH_A,
        relative_path="../outside/transcript.json",
    )

    with pytest.raises(CorrectionPointerError, match="outside the corrections root"):
        load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root)


def test_artifact_not_matching_its_hash_stops_the_build(corrections_root: Path) -> None:
    _publish_correction(corrections_root, audio_hash=HASH_A, corrupt=True)

    with pytest.raises(CorrectionPointerError, match="does not match the hash"):
        load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root)


def test_pointer_keyed_by_something_other_than_a_full_hash_stops_the_build(
    corrections_root: Path,
) -> None:
    # Machine transcripts are keyed by the lowercased full digest; anything
    # else would index the correction beside the machine text, not in its place.
    short = "abc123"
    _publish_correction(corrections_root, audio_hash=short)

    with pytest.raises(CorrectionPointerError, match="not a full SHA-256"):
        load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root)


def test_pointer_hash_case_is_normalized(corrections_root: Path) -> None:
    target = _publish_correction(corrections_root, audio_hash=HASH_A)
    pointer_path = (
        corrections_root / f"corrections_{CATALOG_ID}" / "index-sources" / f"{HASH_A}.json"
    )
    payload = json.loads(pointer_path.read_text(encoding="utf-8"))
    payload["audio_hash"] = HASH_A.upper()
    pointer_path.write_text(json.dumps(payload), encoding="utf-8")

    pointers = load_correction_index_pointers(CATALOG_ID, corrections_root=corrections_root)

    assert set(pointers) == {HASH_A}
    assert pointers[HASH_A].transcript_path == target


def test_correction_replaces_the_machine_source_for_its_recording(
    corrections_root: Path, tmp_path: Path
) -> None:
    machine = tmp_path / "machine" / "transcript.json"
    _write_transcript(machine, [{"start": 0.0, "end": 1.0, "text": "machine"}])
    corrected = _publish_correction(corrections_root, audio_hash=HASH_A)

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
    _publish_correction(corrections_root, audio_hash=HASH_A)

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

    corrected = _publish_correction(
        corrections_root,
        audio_hash=HASH_A,
        segments=[{"start": 0.0, "end": 2.0, "text": "misheard human words"}],
    )

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

    _publish_correction(
        corrections_root,
        audio_hash=HASH_A,
        segments=[{"start": 0.0, "end": 2.0, "text": "misheard human words"}],
    )

    after = discover_transcript_sources(
        workflow_group_id=CATALOG_ID,
        backend_key=BACKEND,
        transcripts_root=transcripts_root,
        corrections_root=corrections_root,
    ).sources[0]

    assert before.audio_hash == after.audio_hash == HASH_A
    assert before.transcript_fingerprint != after.transcript_fingerprint


def test_legacy_short_directory_still_matches_its_pointer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, corrections_root: Path
) -> None:
    """A machine transcript under a short directory name names its recording in
    its metadata. It must be matched to its pointer there, or the machine file
    and the correction would both be indexed and the scope build would abort on
    the duplicate hash."""
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )
    transcripts_root = tmp_path / "transcripts_20260206_120000"
    workflow, model = BACKEND.split("/")
    legacy = transcripts_root / workflow / model / HASH_A[:12] / "transcript.json"
    _write_transcript(legacy, [{"start": 0.0, "end": 2.0, "text": "legacy machine words"}])
    payload = json.loads(legacy.read_text(encoding="utf-8"))
    payload["meta"]["audio_hash"] = HASH_A
    legacy.write_text(json.dumps(payload), encoding="utf-8")

    corrected = _publish_correction(
        corrections_root,
        audio_hash=HASH_A,
        segments=[{"start": 0.0, "end": 2.0, "text": "legacy human words"}],
    )

    sources = discover_transcript_sources(
        workflow_group_id=CATALOG_ID,
        backend_key=BACKEND,
        transcripts_root=transcripts_root,
        corrections_root=corrections_root,
    )
    assert [source.audio_hash for source in sources.sources] == [HASH_A]
    assert sources.sources[0].transcript_path == str(corrected)

    corpus = build_chunk_corpus(
        workflow_group_id=CATALOG_ID,
        backend_key=BACKEND,
        transcripts_root=transcripts_root,
        corrections_root=corrections_root,
    )
    assert {chunk.audio_hash for chunk in corpus.chunks} == {HASH_A}
    assert all("human" in chunk.text for chunk in corpus.chunks)


def test_malformed_legacy_transcript_is_skipped_not_fatal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, corrections_root: Path
) -> None:
    """One unreadable file under a short directory must not abort the scope;
    it stays on the per-file path, where the builders count it as skipped."""
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )
    transcripts_root = tmp_path / "transcripts_20260206_120000"
    workflow, model = BACKEND.split("/")
    _write_transcript(
        transcripts_root / workflow / model / HASH_A / "transcript.json",
        [{"start": 0.0, "end": 2.0, "text": "good machine words"}],
    )
    broken = transcripts_root / workflow / model / "short12" / "transcript.json"
    broken.parent.mkdir(parents=True, exist_ok=True)
    broken.write_text("{ not json", encoding="utf-8")

    sources = discover_transcript_sources(
        workflow_group_id=CATALOG_ID,
        backend_key=BACKEND,
        transcripts_root=transcripts_root,
        corrections_root=corrections_root,
    )
    assert [source.audio_hash for source in sources.sources] == [HASH_A]
    assert sources.transcripts_skipped == 1

    corpus = build_chunk_corpus(
        workflow_group_id=CATALOG_ID,
        backend_key=BACKEND,
        transcripts_root=transcripts_root,
        corrections_root=corrections_root,
    )
    assert {chunk.audio_hash for chunk in corpus.chunks} == {HASH_A}
    assert corpus.transcripts_skipped == 1
