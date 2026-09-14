from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from besedy.commands.catalog import check as check_module
from besedy.lib.rag_bundle import ResolvedColbertBundle, resolve_colbert_bundle_artifacts
from besedy.lib.rag_colbert_source_state import ColbertSourceStateRow, replace_source_state

BACKEND_KEY = "faster-whisper/large-v3@silero_vad_v6"
HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64


class _StubWorkflow:
    """Minimal stand-in for WorkflowConfig as used by the ColBERT checks."""

    workflow_label = "faster-whisper"

    def output_component(self, _sanitizer) -> str:
        return "large-v3@silero_vad_v6"


def _row(audio_hash: str, *, chunk_count: int = 3) -> ColbertSourceStateRow:
    return ColbertSourceStateRow(
        audio_hash=audio_hash,
        transcript_path=f"/tmp/{audio_hash}.json",
        transcript_fingerprint=f"tfp-{audio_hash}",
        chunking_fingerprint="chunking-fp",
        bundle_fingerprint="bundle-fp",
        chunk_count=chunk_count,
        last_run_id="20260101_000000",
    )


def _write_transcript(transcripts_root: Path, audio_hash: str) -> None:
    workflow_dir, model_component = BACKEND_KEY.split("/", maxsplit=1)
    target = transcripts_root / workflow_dir / model_component / audio_hash
    target.mkdir(parents=True, exist_ok=True)
    (target / "transcript.json").write_text("{}", encoding="utf-8")


@pytest.fixture
def colbert_env(monkeypatch, tmp_path: Path) -> tuple[Path, Path]:
    """Point the ColBERT scope at a tmp transcripts root and bundle directory."""

    transcripts_root = tmp_path / "transcripts_20260101_000000"
    transcripts_root.mkdir()
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()

    monkeypatch.setattr(
        check_module,
        "get_transcription_workflows",
        lambda **_kwargs: [_StubWorkflow()],
    )
    monkeypatch.setattr(check_module, "resolve_default_colbert_model", lambda: "colbert-model")
    monkeypatch.setattr(
        check_module,
        "resolve_colbert_scope_bundle",
        lambda **_kwargs: ResolvedColbertBundle(
            artifacts=resolve_colbert_bundle_artifacts(bundle_dir),
            chunk_version="v1",
            built_at=None,
        ),
    )
    return transcripts_root, bundle_dir


def test_hash_coverage_ok_when_every_transcribed_hash_is_indexed(colbert_env) -> None:
    transcripts_root, bundle_dir = colbert_env
    _write_transcript(transcripts_root, HASH_A)
    _write_transcript(transcripts_root, HASH_B)
    replace_source_state(
        path=bundle_dir / "source_state.sqlite",
        rows=[_row(HASH_A), _row(HASH_B)],
    )

    ok, msg, stats = check_module.require_colbert_hash_coverage(transcripts_root, {HASH_A, HASH_B})

    assert ok is True
    assert msg is None
    assert stats == {
        BACKEND_KEY: {
            "total": 2,
            "expected": 2,
            "missing": 0,
            "missing_hashes": [],
            "stale": 0,
            "stale_hashes": [],
            "empty": 0,
            "not_transcribed": 0,
        }
    }


def test_hash_coverage_reports_unindexed_hash(colbert_env) -> None:
    transcripts_root, bundle_dir = colbert_env
    _write_transcript(transcripts_root, HASH_A)
    _write_transcript(transcripts_root, HASH_B)
    replace_source_state(path=bundle_dir / "source_state.sqlite", rows=[_row(HASH_A)])

    ok, msg, stats = check_module.require_colbert_hash_coverage(transcripts_root, {HASH_A, HASH_B})

    assert ok is False
    assert msg is not None
    assert f"{BACKEND_KEY} missing 1" in msg
    assert stats is not None
    assert stats[BACKEND_KEY]["missing_hashes"] == [HASH_B]


def test_hash_coverage_counts_zero_chunk_rows_as_missing(colbert_env) -> None:
    transcripts_root, bundle_dir = colbert_env
    _write_transcript(transcripts_root, HASH_A)
    replace_source_state(
        path=bundle_dir / "source_state.sqlite",
        rows=[_row(HASH_A, chunk_count=0)],
    )

    ok, msg, stats = check_module.require_colbert_hash_coverage(transcripts_root, {HASH_A})

    assert ok is False
    assert msg is not None
    assert "indexed with no chunks" in msg
    assert stats is not None
    assert stats[BACKEND_KEY]["missing_hashes"] == [HASH_A]
    assert stats[BACKEND_KEY]["empty"] == 1


def test_hash_coverage_ignores_catalog_entries_without_transcripts(colbert_env) -> None:
    transcripts_root, bundle_dir = colbert_env
    _write_transcript(transcripts_root, HASH_A)
    replace_source_state(path=bundle_dir / "source_state.sqlite", rows=[_row(HASH_A)])

    ok, _msg, stats = check_module.require_colbert_hash_coverage(transcripts_root, {HASH_A, HASH_C})

    assert ok is True
    assert stats is not None
    assert stats[BACKEND_KEY]["expected"] == 1
    assert stats[BACKEND_KEY]["not_transcribed"] == 1


def test_hash_coverage_reports_stale_indexed_hashes(colbert_env) -> None:
    transcripts_root, bundle_dir = colbert_env
    _write_transcript(transcripts_root, HASH_A)
    replace_source_state(
        path=bundle_dir / "source_state.sqlite",
        rows=[_row(HASH_A), _row(HASH_B)],
    )

    ok, msg, stats = check_module.require_colbert_hash_coverage(transcripts_root, {HASH_A})

    assert ok is False
    assert msg is not None
    assert f"{BACKEND_KEY} stale 1" in msg
    assert stats is not None
    assert stats[BACKEND_KEY]["stale_hashes"] == [HASH_B]


def test_hash_coverage_skips_when_source_state_absent(colbert_env) -> None:
    transcripts_root, _bundle_dir = colbert_env
    _write_transcript(transcripts_root, HASH_A)

    ok, msg, stats = check_module.require_colbert_hash_coverage(transcripts_root, {HASH_A})

    assert ok is None
    assert stats is None
    assert msg is not None
    assert "No ColBERT source state" in msg


def test_hash_coverage_reports_corrupt_source_state(colbert_env) -> None:
    transcripts_root, bundle_dir = colbert_env
    _write_transcript(transcripts_root, HASH_A)
    (bundle_dir / "source_state.sqlite").write_bytes(b"not a database at all")

    ok, msg, _stats = check_module.require_colbert_hash_coverage(transcripts_root, {HASH_A})

    assert ok is False
    assert msg is not None
    assert msg.startswith("Unable to read ColBERT source state for backend(s):")


def test_hash_coverage_reports_locked_source_state(colbert_env, monkeypatch) -> None:
    transcripts_root, bundle_dir = colbert_env
    _write_transcript(transcripts_root, HASH_A)
    replace_source_state(path=bundle_dir / "source_state.sqlite", rows=[_row(HASH_A)])

    def _locked(*_args, **_kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(check_module, "read_source_state", _locked)

    ok, msg, _stats = check_module.require_colbert_hash_coverage(transcripts_root, {HASH_A})

    assert ok is False
    assert msg is not None
    assert "database is locked" in msg
