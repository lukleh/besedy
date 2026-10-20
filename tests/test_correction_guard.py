"""Staged audio of live correction workspaces is never deleted or re-staged (ADR 0012)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from besedy.lib.audio.normalize import stage_audio_files
from besedy.lib.audio.types import ManifestWriter
from besedy.lib.catalog.cleaner import CleanupPlan, CleanupTarget, execute_cleanup
from besedy.lib.catalog.remover import RemovalPlan, execute_removal
from besedy.lib.correction_guard import (
    CorrectionManifestError,
    is_protected,
    load_protected_staged_audio,
)
from besedy.lib.workflow.common import CsvAudioRow

HASH = "a" * 64
OTHER = "b" * 64


def write_manifest(
    root: Path, workspace: str, staged: Path, status: str = "active", **extra
) -> Path:
    path = root / "corrections_20251222_144441" / workspace / "workspace.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "schema_version": 1,
        "workflow_group_id": "20251222_144441",
        "audio_hash": HASH,
        "workspace_id": workspace,
        "status": status,
        "segmentation_version": "chunks-v1",
        "staged_audio": {"path": str(staged), "size": 8, "sha256": "0" * 64},
        "updated_at": "2026-10-20T00:00:00.000Z",
        **extra,
    }
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


@pytest.fixture
def staged(tmp_path: Path) -> tuple[Path, Path, Path]:
    staging = tmp_path / "audio_staged_20251222_144441"
    staging.mkdir()
    protected_file = staging / f"{HASH}.wav"
    other_file = staging / f"{OTHER}.wav"
    protected_file.write_bytes(b"RIFFkeep")
    other_file.write_bytes(b"RIFFgone")
    return staging, protected_file, other_file


def test_only_active_workspaces_protect_their_audio(tmp_path: Path, staged) -> None:
    _, protected_file, other_file = staged
    corrections = tmp_path / "corrections"
    write_manifest(corrections, "ws-live", protected_file)
    write_manifest(corrections, "ws-archived", other_file, status="archived")

    protected = load_protected_staged_audio(corrections)

    assert is_protected(protected_file, protected)
    assert not is_protected(other_file, protected)
    assert protected[protected_file.resolve()].workspace_id == "ws-live"


def test_a_symlinked_staging_directory_still_matches(tmp_path: Path, staged) -> None:
    staging, protected_file, _ = staged
    link = tmp_path / "audio_staged"
    link.symlink_to(staging)
    corrections = tmp_path / "corrections"
    write_manifest(corrections, "ws-live", protected_file)

    assert is_protected(link / protected_file.name, load_protected_staged_audio(corrections))


def test_no_corrections_tree_protects_nothing(tmp_path: Path) -> None:
    assert load_protected_staged_audio(tmp_path / "missing") == {}


@pytest.mark.parametrize(
    "damage", ["not json", json.dumps({"schema_version": 9}), json.dumps({"schema_version": 1})]
)
def test_an_unreadable_manifest_stops_the_command(tmp_path: Path, staged, damage: str) -> None:
    _, protected_file, _ = staged
    corrections = tmp_path / "corrections"
    path = write_manifest(corrections, "ws-live", protected_file)
    path.write_text(damage, encoding="utf-8")

    with pytest.raises(CorrectionManifestError):
        load_protected_staged_audio(corrections)


def test_clean_keeps_protected_staged_audio(tmp_path: Path, staged) -> None:
    _, protected_file, other_file = staged
    corrections = tmp_path / "corrections"
    write_manifest(corrections, "ws-live", protected_file)
    plan = CleanupPlan(
        targets=[
            CleanupTarget(
                sha256=HASH,
                original_path="/gone/a.wav",
                staged_path=protected_file,
                staged_exists=True,
            ),
            CleanupTarget(
                sha256=OTHER,
                original_path="/gone/b.wav",
                staged_path=other_file,
                staged_exists=True,
            ),
        ],
        catalog_csv=tmp_path / "catalog.csv",
        normalized_csv=None,
    )

    result = execute_cleanup(plan, load_protected_staged_audio(corrections))

    assert protected_file.exists()
    assert not other_file.exists()
    assert result.staged_kept_for_correction == [protected_file]
    assert result.staged_removed == 1


def test_remove_keeps_protected_staged_audio(tmp_path: Path, staged) -> None:
    _, protected_file, other_file = staged
    corrections = tmp_path / "corrections"
    write_manifest(corrections, "ws-live", protected_file)
    plan = RemovalPlan(
        sha256=HASH, catalog_csv=tmp_path / "catalog.csv", staged_files=[protected_file, other_file]
    )

    result = execute_removal(plan, load_protected_staged_audio(corrections))

    assert protected_file.exists()
    assert not other_file.exists()
    assert result.files_kept_for_correction == [protected_file]
    assert result.ok


def test_overwrite_staging_reuses_protected_audio(tmp_path: Path, staged) -> None:
    staging, protected_file, _ = staged
    corrections = tmp_path / "corrections"
    write_manifest(corrections, "ws-live", protected_file)
    manifest = ManifestWriter(tmp_path / "manifest.csv", include_analysis=False)

    prepared, skipped = stage_audio_files(
        rows=[
            CsvAudioRow(sha256=HASH, full_path=str(tmp_path / "source.mp3"), duration_seconds=1.0)
        ],
        staging_dir=staging,
        manifest_writer=manifest,
        include_audio_analysis=False,
        analysis_ffmpeg="ffmpeg",
        analysis_ffprobe="ffprobe",
        continue_on_error=True,
        reuse_existing=False,
        protected=load_protected_staged_audio(corrections),
    )
    manifest.close()

    assert protected_file.read_bytes() == b"RIFFkeep"
    assert [entry.action for entry in prepared] == ["existing"]
    assert skipped == []
