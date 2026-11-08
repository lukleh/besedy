"""Tests for the CI check on the names of newly added Prisma migrations."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
CHECK = REPO_ROOT / "scripts" / "check_migration_names.sh"

BASE_MIGRATIONS = [
    # Two applied migrations already share a timestamp; existing names stay.
    "20260919120000_add_event_poster_publication",
    "20260919120000_add_recording_intake",
    "20260930093148_catalog_aac_path",
]


# Keep the developer's git config (signing, hooks) out of the scratch repo.
GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=test", "-c", "user.email=test@example.com", *args],
        cwd=repo,
        env=GIT_ENV,
        check=True,
        capture_output=True,
    )


def _add_migration(repo: Path, name: str) -> None:
    directory = repo / "web" / "prisma" / "migrations" / name
    directory.mkdir(parents=True)
    (directory / "migration.sql").write_text("SELECT 1;\n", encoding="utf-8")


def _init_repo(path: Path, migrations: list[str]) -> Path:
    _git(path, "init", "-q", "-b", "main")
    for name in migrations:
        _add_migration(path, name)
    (path / "web" / "prisma" / "migrations" / "migration_lock.toml").write_text(
        'provider = "postgresql"\n', encoding="utf-8"
    )
    _git(path, "add", ".")
    _git(path, "commit", "-q", "-m", "base")
    return path


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    return _init_repo(tmp_path, BASE_MIGRATIONS)


def _check(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(CHECK), "main"],
        cwd=repo,
        env=GIT_ENV,
        capture_output=True,
        text=True,
        check=False,
    )


def test_no_added_migrations_passes(repo: Path) -> None:
    result = _check(repo)

    assert result.returncode == 0, result.stdout
    assert "No migrations added" in result.stdout


def test_migrations_after_the_base_pass(repo: Path) -> None:
    _add_migration(repo, "20261003090000_first")
    _add_migration(repo, "20261003091000_second")

    result = _check(repo)

    assert result.returncode == 0, result.stdout
    assert "20261003090000_first" in result.stdout
    assert "20261003091000_second" in result.stdout


@pytest.mark.parametrize(
    "name",
    [
        "20260920120000_older_than_main",
        "20260930093148_same_as_latest",
        "20260919120000_reuses_an_old_timestamp",
    ],
)
def test_migration_not_after_the_base_fails(repo: Path, name: str) -> None:
    _add_migration(repo, name)

    result = _check(repo)

    assert result.returncode == 1
    assert f"::error::{name}" in result.stdout
    assert "20260930093148" in result.stdout


def test_added_migrations_sharing_a_timestamp_fail(repo: Path) -> None:
    _add_migration(repo, "20261003090000_first")
    _add_migration(repo, "20261003090000_second")

    result = _check(repo)

    assert result.returncode == 1
    assert "share the timestamp 20261003090000" in result.stdout


@pytest.mark.parametrize("name", ["add_without_timestamp", "2026100309_short_timestamp"])
def test_migration_without_a_full_timestamp_fails(repo: Path, name: str) -> None:
    _add_migration(repo, name)

    result = _check(repo)

    assert result.returncode == 1
    assert f"::error::{name}: the name must start with a 14-digit timestamp" in result.stdout


@pytest.mark.parametrize(
    "new_name",
    [
        "20260919120500_add_recording_intake",
        # A later timestamp passes the ordering rule, but production would
        # treat the renamed migration as new and run its SQL again.
        "20261003090000_add_recording_intake",
    ],
)
def test_renaming_an_applied_migration_fails(repo: Path, new_name: str) -> None:
    old = repo / "web" / "prisma" / "migrations" / "20260919120000_add_recording_intake"
    old.rename(old.with_name(new_name))

    result = _check(repo)

    assert result.returncode == 1
    assert (
        "::error::20260919120000_add_recording_intake: this migration is on main" in result.stdout
    )


def test_deleting_an_applied_migration_fails(repo: Path) -> None:
    applied = repo / "web" / "prisma" / "migrations" / "20260930093148_catalog_aac_path"
    (applied / "migration.sql").unlink()
    applied.rmdir()

    result = _check(repo)

    assert result.returncode == 1
    assert "::error::20260930093148_catalog_aac_path: this migration is on main" in result.stdout


def test_base_without_timestamped_migrations_still_reports(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path, ["0000_init"])
    _add_migration(repo, "20261003090000_first")
    _add_migration(repo, "add_without_timestamp")

    result = _check(repo)

    assert result.returncode == 1
    assert "::error::add_without_timestamp" in result.stdout
    assert "20261003090000_first" not in result.stdout


def _squash_to_baseline(repo: Path) -> None:
    root = repo / "web/prisma/migrations"
    retired = {
        p.parent.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in root.glob("*/migration.sql")
    }
    for name in retired:
        shutil.rmtree(root / name)
    baseline = "20261108000000_current_schema"
    _add_migration(repo, baseline)
    checksum = hashlib.sha256((root / baseline / "migration.sql").read_bytes()).hexdigest()
    (repo / "web/prisma/baseline.json").write_text(
        json.dumps(
            {
                "baseline": baseline,
                "baseline_checksum": checksum,
                "retired_migrations": retired,
            }
        )
    )


def test_reviewed_complete_baseline_can_replace_history(repo: Path) -> None:
    _squash_to_baseline(repo)
    result = _check(repo)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Verified current-schema baseline" in result.stdout


def test_baseline_cannot_hide_unreviewed_history_change(repo: Path) -> None:
    _squash_to_baseline(repo)
    manifest = repo / "web/prisma/baseline.json"
    content = json.loads(manifest.read_text())
    content["retired_migrations"][BASE_MIGRATIONS[0]] = "wrong"
    manifest.write_text(json.dumps(content))
    result = _check(repo)
    assert result.returncode == 1
    assert "Migration changed" in result.stderr


def test_existing_baseline_does_not_allow_future_migration_deletion(repo: Path) -> None:
    _squash_to_baseline(repo)
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "baseline")
    shutil.rmtree(repo / "web/prisma/migrations/20261108000000_current_schema")
    result = _check(repo)
    assert result.returncode == 1


def test_baseline_cannot_retire_only_part_of_history(repo: Path) -> None:
    original = repo / "web/prisma/migrations" / BASE_MIGRATIONS[0] / "migration.sql"
    original_sql = original.read_text()
    _squash_to_baseline(repo)
    _add_migration(repo, BASE_MIGRATIONS[0])
    original.write_text(original_sql)
    manifest_path = repo / "web/prisma/baseline.json"
    manifest = json.loads(manifest_path.read_text())
    del manifest["retired_migrations"][BASE_MIGRATIONS[0]]
    manifest_path.write_text(json.dumps(manifest))
    result = _check(repo)
    assert result.returncode == 1
    assert "complete base migration history" in result.stderr
