"""Guardrails for the operator-facing Justfile surface."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]

RETIRED_RECIPES = {
    "jobs-up",
    "jobs-down",
    "jobs-down-clean",
    "jobs-logs",
    "jobs-rebuild",
    "jobs-status",
    "jobs-db",
    "jobs-deploy",
    "prefect-deploy",
    "embeddings-up",
    "embeddings-down",
    "embeddings-logs",
    "artwork-storage",
}

SHARED_COLBERT_RECIPES = (
    "rag-services-up",
    "rag-services-down",
    "colbert-up",
    "colbert-down",
)

requires_just = pytest.mark.skipif(shutil.which("just") is None, reason="requires just")


def _dump_justfile() -> dict:
    result = subprocess.run(
        ["just", "--dump", "--dump-format", "json"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


@requires_just
def test_retired_operator_recipes_are_removed() -> None:
    dump = _dump_justfile()

    assert RETIRED_RECIPES.isdisjoint(dump["recipes"])
    assert RETIRED_RECIPES.isdisjoint(dump["aliases"])


@requires_just
def test_shared_colbert_recipes_run_the_checkout_guard_first() -> None:
    recipes = _dump_justfile()["recipes"]

    for name in SHARED_COLBERT_RECIPES:
        first = recipes[name]["dependencies"][0]
        # Newer just versions add keys to the dump; compare only what the guard relies on.
        assert (first["recipe"], first["arguments"]) == ("_guard-shared-colbert", [name])


def _run_guard(
    tmp_path: Path,
    recipe: str,
    *,
    container_exists: bool,
    working_dir: str = "",
    container_state: str = "running",
    force: bool = False,
) -> subprocess.CompletedProcess[str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(
        "#!/usr/bin/env bash\n"
        '[ "$STUB_CONTAINER_STATUS" = 0 ] || exit 1\n'
        'printf "%s %s\\n" "$STUB_CONTAINER_STATE" "$STUB_WORKING_DIR"\n',
        encoding="utf-8",
    )
    docker.chmod(0o755)
    env = os.environ.copy()
    env.pop("BESEDY_COLBERT_FORCE", None)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    env["STUB_CONTAINER_STATUS"] = "0" if container_exists else "1"
    env["STUB_WORKING_DIR"] = working_dir
    env["STUB_CONTAINER_STATE"] = container_state
    if force:
        env["BESEDY_COLBERT_FORCE"] = "1"
    return subprocess.run(
        ["just", "_guard-shared-colbert", recipe],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


@requires_just
def test_colbert_guard_allows_when_no_container_exists(tmp_path: Path) -> None:
    result = _run_guard(tmp_path, "colbert-up", container_exists=False)

    assert result.returncode == 0, result.stderr


@requires_just
def test_colbert_guard_allows_the_owning_checkout(tmp_path: Path) -> None:
    result = _run_guard(
        tmp_path,
        "colbert-down",
        container_exists=True,
        working_dir=str(PROJECT_ROOT / "rag-services"),
    )

    assert result.returncode == 0, result.stderr


@requires_just
def test_colbert_guard_allows_the_owning_checkout_through_a_symlink(tmp_path: Path) -> None:
    link = tmp_path / "checkout"
    link.symlink_to(PROJECT_ROOT, target_is_directory=True)

    result = _run_guard(
        tmp_path,
        "colbert-down",
        container_exists=True,
        working_dir=str(link / "rag-services"),
    )

    assert result.returncode == 0, result.stderr


@requires_just
def test_colbert_guard_refuses_another_checkout_for_up(tmp_path: Path) -> None:
    other = tmp_path / "prod-colbert" / "rag-services"
    other.mkdir(parents=True)

    result = _run_guard(tmp_path, "colbert-up", container_exists=True, working_dir=str(other))

    assert result.returncode == 1
    assert "Container state: running" in result.stderr
    assert f"Owning ColBERT checkout: {other}" in result.stderr
    assert f"(cd {other}/.. && just colbert-up)" in result.stderr
    assert "docker compose" not in result.stderr


@requires_just
def test_colbert_guard_points_down_recipes_at_the_owning_checkout(tmp_path: Path) -> None:
    other = tmp_path / "prod-colbert" / "rag-services"
    other.mkdir(parents=True)

    result = _run_guard(tmp_path, "colbert-down", container_exists=True, working_dir=str(other))

    assert result.returncode == 1
    assert "just colbert-down" in result.stderr
    assert "up -d" not in result.stderr


@requires_just
def test_colbert_guard_refuses_a_container_without_a_compose_label(tmp_path: Path) -> None:
    result = _run_guard(tmp_path, "rag-services-down", container_exists=True)

    assert result.returncode == 1
    assert "Owning ColBERT checkout: <unknown>" in result.stderr
    assert "(cd <owning-checkout>/rag-services/.. && just rag-services-down)" in result.stderr


@requires_just
def test_colbert_guard_reports_a_stopped_container_state(tmp_path: Path) -> None:
    result = _run_guard(
        tmp_path,
        "colbert-up",
        container_exists=True,
        working_dir="/elsewhere/rag-services",
        container_state="exited",
    )

    assert result.returncode == 1
    assert "Container state: exited" in result.stderr
    assert "Running ColBERT checkout" not in result.stderr


@requires_just
def test_colbert_guard_names_a_removed_owning_checkout(tmp_path: Path) -> None:
    gone = tmp_path / "removed-worktree" / "rag-services"

    result = _run_guard(tmp_path, "colbert-up", container_exists=True, working_dir=str(gone))

    assert result.returncode == 1
    assert f"Owning ColBERT checkout: {gone}" in result.stderr
    assert "missing or not readable" in result.stderr
    assert "(cd " not in result.stderr
    assert "BESEDY_COLBERT_FORCE=1" in result.stderr


@requires_just
def test_colbert_guard_refuses_an_unreadable_owning_checkout(tmp_path: Path) -> None:
    if os.geteuid() == 0:
        pytest.skip("root ignores directory permissions")
    locked = tmp_path / "locked"
    locked.mkdir(mode=0o000)
    try:
        result = _run_guard(
            tmp_path,
            "colbert-down",
            container_exists=True,
            working_dir=str(locked / "rag-services"),
        )
    finally:
        locked.chmod(0o700)

    assert result.returncode == 1
    assert "Refusing to run 'colbert-down'" in result.stderr
    assert "missing or not readable" in result.stderr


@requires_just
def test_colbert_guard_force_override(tmp_path: Path) -> None:
    result = _run_guard(
        tmp_path,
        "colbert-down",
        container_exists=True,
        working_dir="/elsewhere/rag-services",
        force=True,
    )

    assert result.returncode == 0
    assert "BESEDY_COLBERT_FORCE=1" in result.stdout


@requires_just
def test_colbert_guard_does_not_evaluate_the_recipe_argument(tmp_path: Path) -> None:
    marker = tmp_path / "evaluated"

    result = _run_guard(tmp_path, f'x"; touch {marker}; echo "', container_exists=True)

    assert result.returncode == 1
    assert not marker.exists()
