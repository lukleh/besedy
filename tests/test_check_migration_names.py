"""Tests for the CI check on the names of newly added Prisma migrations."""

from __future__ import annotations

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


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=test", "-c", "user.email=test@example.com", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


def _add_migration(repo: Path, name: str) -> None:
    directory = repo / "web" / "prisma" / "migrations" / name
    directory.mkdir(parents=True)
    (directory / "migration.sql").write_text("SELECT 1;\n", encoding="utf-8")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q", "-b", "main")
    for name in BASE_MIGRATIONS:
        _add_migration(tmp_path, name)
    (tmp_path / "web" / "prisma" / "migrations" / "migration_lock.toml").write_text(
        'provider = "postgresql"\n', encoding="utf-8"
    )
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-q", "-m", "base")
    return tmp_path


def _check(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(CHECK), "main"],
        cwd=repo,
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


def test_renaming_an_applied_migration_fails(repo: Path) -> None:
    old = repo / "web" / "prisma" / "migrations" / "20260919120000_add_recording_intake"
    old.rename(old.with_name("20260919120500_add_recording_intake"))

    result = _check(repo)

    assert result.returncode == 1
    assert "::error::20260919120500_add_recording_intake" in result.stdout
