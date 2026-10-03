"""scripts/check_uv_lock_at_rev.sh against throwaway repositories."""

import shutil
import subprocess
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT_ROOT / "scripts" / "check_uv_lock_at_rev.sh"

pytestmark = pytest.mark.skipif(shutil.which("uv") is None, reason="requires uv")

PYPROJECT = """[project]
name = "demo"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = []
"""


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.email=t@example.com", "-c", "user.name=t", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _commit(repo: Path) -> str:
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "c")
    return _git(repo, "rev-parse", "HEAD")


def _check(repo: Path, rev: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), rev], cwd=repo, capture_output=True, text=True, check=False
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q")
    (tmp_path / "pyproject.toml").write_text(PYPROJECT, encoding="utf-8")
    subprocess.run(["uv", "lock"], cwd=tmp_path, capture_output=True, text=True, check=True)
    return tmp_path


def test_consistent_lock_passes(repo: Path) -> None:
    rev = _commit(repo)

    result = _check(repo, rev)

    assert result.returncode == 0, result.stderr


def test_lock_that_drifted_from_pyproject_is_refused_even_when_the_checkout_matches(
    repo: Path,
) -> None:
    good = _commit(repo)
    (repo / "pyproject.toml").write_text(
        PYPROJECT.replace("dependencies = []", 'dependencies = ["tqdm"]'), encoding="utf-8"
    )
    bad = _commit(repo)

    assert _check(repo, good).returncode == 0
    result = _check(repo, bad)
    assert result.returncode == 1
    assert "uv lock --check failed" in result.stderr
    assert "needs to be updated" in result.stderr


def test_revision_without_a_lock_is_refused(repo: Path) -> None:
    (repo / "uv.lock").unlink()
    rev = _commit(repo)

    result = _check(repo, rev)

    assert result.returncode == 1
    assert "uv.lock is missing" in result.stderr


def test_revision_argument_is_required() -> None:
    result = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, check=False)

    assert result.returncode == 2
    assert "Usage" in result.stderr
