"""Staged audio of live correction workspaces is never deleted or re-staged (ADR 0012)."""

from __future__ import annotations

import json
import logging
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
        "updated_at": "2026-10-20T11:30:00.000Z",
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


def test_archived_workspaces_are_ignored(tmp_path: Path, staged) -> None:
    _, protected_file, _ = staged
    corrections = tmp_path / "corrections"
    write_manifest(corrections, "ws-archived", protected_file, status="archived")

    assert load_protected_staged_audio(corrections) == {}


@pytest.mark.parametrize("updated_at", ["2026-10-20T11:30:00.000Z", "2020-01-01T00:00:00.000Z"])
def test_a_starting_workspace_protects_its_audio_however_old(
    tmp_path: Path, staged, updated_at: str
) -> None:
    # Without the database a start that crashed after its commit cannot be
    # told from one that crashed before it, so neither ever expires.
    _, protected_file, _ = staged
    corrections = tmp_path / "corrections"
    write_manifest(
        corrections, "ws-starting", protected_file, status="starting", updated_at=updated_at
    )

    assert is_protected(protected_file, load_protected_staged_audio(corrections))


def test_a_manifest_without_a_status_stops_the_command(tmp_path: Path, staged) -> None:
    _, protected_file, _ = staged
    corrections = tmp_path / "corrections"
    write_manifest(corrections, "ws-broken", protected_file, status=None)

    with pytest.raises(CorrectionManifestError, match="status"):
        load_protected_staged_audio(corrections)


def test_a_manifest_naming_a_missing_file_still_protects_that_path(tmp_path: Path, staged) -> None:
    staging, _, _ = staged
    corrections = tmp_path / "corrections"
    missing = staging / f"{'c' * 64}.wav"
    write_manifest(corrections, "ws-live", missing)

    protected = load_protected_staged_audio(corrections)

    assert not missing.exists()
    assert is_protected(missing, protected)
    assert protected[missing.resolve()].audio_hash == HASH


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


def test_a_broken_manifest_in_another_catalog_stops_the_command(tmp_path: Path, staged) -> None:
    """Intended: the manifest, not its catalog directory, says which file it guards."""
    _, protected_file, other_file = staged
    corrections = tmp_path / "corrections"
    write_manifest(corrections, "ws-live", protected_file)
    broken = corrections / "corrections_20260101_000000" / "ws-other" / "workspace.json"
    broken.parent.mkdir(parents=True)
    broken.write_text("not json", encoding="utf-8")

    with pytest.raises(CorrectionManifestError, match=str(broken)) as excinfo:
        load_protected_staged_audio(corrections)
    assert "Fix or restore it" in str(excinfo.value)

    plan = CleanupPlan(
        targets=[
            CleanupTarget(
                sha256=OTHER,
                original_path="/gone/b.wav",
                staged_path=other_file,
                staged_exists=True,
            )
        ],
        catalog_csv=tmp_path / "catalog_20251222_144441.csv",
        normalized_csv=None,
    )
    with pytest.raises(CorrectionManifestError):
        execute_cleanup(plan, load_protected_staged_audio(corrections))
    assert other_file.exists()


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


def test_overwrite_staging_warns_when_protected_audio_is_missing(
    tmp_path: Path, staged, caplog
) -> None:
    staging, protected_file, _ = staged
    protected_file.unlink()
    corrections = tmp_path / "corrections"
    write_manifest(corrections, "ws-live", protected_file)
    manifest = ManifestWriter(tmp_path / "manifest.csv", include_analysis=False)

    with caplog.at_level(logging.WARNING):
        prepared, skipped = stage_audio_files(
            rows=[
                CsvAudioRow(
                    sha256=HASH, full_path=str(tmp_path / "source.mp3"), duration_seconds=1.0
                )
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

    messages = [record.getMessage() for record in caplog.records]
    assert any(
        str(protected_file) in message and "ws-live" in message and "re-staging" in message
        for message in messages
    )
    # The source is absent too, so the row is skipped rather than converted.
    assert prepared == []
    assert [entry.reason for entry in skipped] == ["file not found"]
