"""The ColBERT sidecar's preload comes from a host env file, not the shell."""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WRAPPER = PROJECT_ROOT / "scripts" / "run_rag_services_compose.sh"
TEMPLATE = PROJECT_ROOT / "rag-services" / ".env.example"
COMPOSE = PROJECT_ROOT / "rag-services" / "docker-compose.yml"
JUSTFILE = PROJECT_ROOT / "Justfile"

# Prints the arguments it was called with instead of running compose.
DOCKER_STUB = """#!/usr/bin/env bash
printf '%s\\n' "$@"
"""


def _env_assignments(path: Path) -> dict[str, str]:
    """Assignments in the template, counting commented-out ones as examples."""

    assignments: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"#?\s*([A-Z][A-Z0-9_]*)=(\S+)$", line)
        if match:
            assignments[match.group(1)] = match.group(2)
    return assignments


def _run(
    tmp_path: Path, *args: str, docker: str | None = None, **env: str
) -> subprocess.CompletedProcess[str]:
    if docker is None:
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir(exist_ok=True)
        stub = bin_dir / "docker"
        stub.write_text(DOCKER_STUB, encoding="utf-8")
        stub.chmod(0o755)
        path = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"
    else:
        path = os.environ["PATH"]
    return subprocess.run(
        ["bash", str(WRAPPER), *args],
        cwd=PROJECT_ROOT,
        env={
            **{
                k: v
                for k, v in os.environ.items()
                if not k.startswith(("BESEDY_", "COLBERT_", "RAG_")) and k != "XDG_CONFIG_HOME"
            },
            "HOME": str(tmp_path),
            "PATH": path,
            **env,
        },
        capture_output=True,
        text=True,
        check=False,
    )


def test_wrapper_passes_the_default_env_file_to_compose(tmp_path: Path) -> None:
    env_file = tmp_path / ".config" / "lukleh" / "besedy" / "rag-services.env"
    env_file.parent.mkdir(parents=True)
    env_file.write_text("COLBERT_PRELOAD_INDEX_DIR=/data/x\n", encoding="utf-8")

    result = _run(tmp_path, "up", "-d", "colbert")

    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == [
        "compose",
        "--env-file",
        str(env_file),
        "-f",
        "rag-services/docker-compose.yml",
        "up",
        "-d",
        "colbert",
    ]


def test_wrapper_honours_the_override_variable(tmp_path: Path) -> None:
    env_file = tmp_path / "elsewhere.env"
    env_file.write_text("", encoding="utf-8")

    result = _run(tmp_path, "ps", BESEDY_RAG_SERVICES_ENV=str(env_file))

    assert result.returncode == 0, result.stderr
    assert result.stdout.split()[1:3] == ["--env-file", str(env_file)]


def test_wrapper_rejects_a_missing_override_file(tmp_path: Path) -> None:
    result = _run(tmp_path, "ps", BESEDY_RAG_SERVICES_ENV=str(tmp_path / "missing.env"))

    assert result.returncode == 1
    assert "BESEDY_RAG_SERVICES_ENV points to missing file" in result.stderr
    assert result.stdout == ""


def test_wrapper_without_a_file_warns_when_it_can_recreate_the_sidecar(tmp_path: Path) -> None:
    result = _run(tmp_path, "up", "-d", "colbert")

    assert result.returncode == 0, result.stderr
    assert "--env-file" not in result.stdout
    assert "starts without a preloaded index" in result.stderr


@pytest.mark.parametrize("args", [("ps",), ("logs", "-f"), ("stop", "colbert"), ("down",)])
def test_wrapper_does_not_warn_for_commands_that_never_start_the_sidecar(
    tmp_path: Path, args: tuple[str, ...]
) -> None:
    result = _run(tmp_path, *args)

    assert result.returncode == 0, result.stderr
    assert result.stderr == ""


def test_wrapper_stays_quiet_when_the_preload_comes_from_the_shell(tmp_path: Path) -> None:
    result = _run(tmp_path, "up", "-d", COLBERT_PRELOAD_INDEX_DIR="/data/x")

    assert result.returncode == 0, result.stderr
    assert result.stderr == ""


def test_justfile_runs_every_rag_services_command_through_the_wrapper() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert 'rag_services_compose := "bash scripts/run_rag_services_compose.sh"' in justfile
    assert "docker compose -f rag-services/docker-compose.yml" not in justfile


def test_template_sets_only_compose_variables_and_preloads_the_symlink() -> None:
    template = _env_assignments(TEMPLATE)
    # A copied template must not carry a placeholder path as a live value.
    live = [line for line in TEMPLATE.read_text(encoding="utf-8").splitlines() if line[:1].isupper()]
    assert live == []
    compose_variables = set(re.findall(r"\$\{(\w+)", COMPOSE.read_text(encoding="utf-8")))

    assert template.keys() <= compose_variables
    preload = template["COLBERT_PRELOAD_INDEX_DIR"]
    assert preload.startswith("/data/state/rag_colbert/")
    assert preload.endswith("/index/colbert_index")
    assert "index_" not in preload


@pytest.mark.skipif(
    shutil.which("docker") is None
    or subprocess.run(["docker", "compose", "version"], capture_output=True, check=False).returncode
    != 0,
    reason="requires docker compose",
)
def test_real_compose_renders_the_preload_from_the_env_file(tmp_path: Path) -> None:
    env_file = tmp_path / "rag-services.env"
    env_file.write_text("COLBERT_PRELOAD_INDEX_DIR=/data/state/rag_colbert/wg/index\n", "utf-8")

    result = _run(
        tmp_path,
        "config",
        docker="real",
        BESEDY_RAG_SERVICES_ENV=str(env_file),
    )

    assert result.returncode == 0, result.stderr
    assert "COLBERT_PRELOAD_INDEX_DIR: /data/state/rag_colbert/wg/index" in result.stdout
