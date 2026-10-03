"""scripts/check_compose_renders.sh covers every Compose file of the repository."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "check_compose_renders.sh"


def _tracked_files() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        pytest.skip("not a git checkout")
    return [name for name in result.stdout.split("\0") if name]


def test_every_compose_file_is_rendered_by_the_check() -> None:
    script = SCRIPT.read_text(encoding="utf-8")
    compose_files = [
        name
        for name in _tracked_files()
        if Path(name).name.startswith("docker-compose") and name.endswith(".yml")
    ]
    assert compose_files, "no compose files found"

    # Web files are rendered together through run_web_compose.sh, which names
    # them by their basename relative to web/.
    missing = [
        name
        for name in compose_files
        if name not in script and not (name.startswith("web/") and name[len("web/") :] in script)
    ]

    assert not missing, f"scripts/check_compose_renders.sh does not render: {missing}"


def test_the_render_check_is_executable_in_git() -> None:
    listed = subprocess.run(
        ["git", "ls-files", "-s", "--", "scripts/check_compose_renders.sh"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    ).stdout.splitlines()
    if not listed:
        pytest.skip("the script is not tracked by git here")

    assert listed[0].split()[0] == "100755"
