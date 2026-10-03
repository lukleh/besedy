"""The host ingest worker's start command is defined once, in run-worker.sh."""

import os
import re
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
HOST_WORKER = PROJECT_ROOT / "jobs-service" / "host-worker"
SCRIPT = HOST_WORKER / "run-worker.sh"
UNIT = HOST_WORKER / "besedy-ingest-worker.service"
JUSTFILE = PROJECT_ROOT / "Justfile"

# Records its arguments and environment instead of starting a worker.
UV_STUB = """#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_UV_ARGS"
"""


def _run(tmp_path: Path, *args: str, **env: str) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    uv = bin_dir / "uv"
    uv.write_text(UV_STUB, encoding="utf-8")
    uv.chmod(0o755)
    uv_args = tmp_path / "uv-args"
    base = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("BESEDY_", "PREFECT_")) and k != "XDG_CONFIG_HOME"
    }
    result = subprocess.run(
        ["bash", str(SCRIPT), *args],
        cwd=tmp_path,
        env={
            **base,
            "HOME": str(tmp_path),
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "FAKE_UV_ARGS": str(uv_args),
            **env,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    return result, uv_args.read_text(encoding="utf-8").split() if uv_args.exists() else []


def test_unit_and_recipe_call_the_script_and_do_not_repeat_the_command() -> None:
    unit = UNIT.read_text(encoding="utf-8")
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert re.search(r"^ExecStart=.*jobs-service/host-worker/run-worker\.sh", unit, re.MULTILINE)
    assert "bash jobs-service/host-worker/run-worker.sh --dev" in justfile
    # The deploy recipe refuses a rollback to a revision that lacks the script.
    assert '$sha:$script"' in justfile
    for path in (UNIT, JUSTFILE):
        assert "worker start" not in path.read_text(encoding="utf-8"), path


def test_script_pins_frozen_lock_and_both_extras(tmp_path: Path) -> None:
    result, args = _run(tmp_path, PREFECT_INGEST_WORK_POOL="besedy-ingest-prod")

    assert result.returncode == 0, result.stderr
    assert args == [
        "run",
        "--frozen",
        "--extra",
        "jobs",
        "--extra",
        "ml",
        "prefect",
        "worker",
        "start",
        "--pool",
        "besedy-ingest-prod",
        "--type",
        "process",
        "--limit",
        "1",
        "--install-policy",
        "never",
    ]
    assert re.search(r"besedy-ingest-worker: revision \S+ in ", result.stdout)


def test_production_mode_requires_the_pool_from_the_caller(tmp_path: Path) -> None:
    result, args = _run(tmp_path)

    assert result.returncode != 0
    assert "PREFECT_INGEST_WORK_POOL must be set" in result.stderr
    assert args == []


def test_dev_mode_defaults_the_pool_and_warns_without_an_env_file(tmp_path: Path) -> None:
    result, args = _run(tmp_path, "--dev")

    assert result.returncode == 0, result.stderr
    assert "Ingest worker env file not found" in result.stderr
    assert args[args.index("--pool") + 1] == "besedy-ingest-dev"


def test_dev_mode_loads_the_env_file(tmp_path: Path) -> None:
    env_file = tmp_path / "ingest-worker.env"
    env_file.write_text("PREFECT_INGEST_WORK_POOL=besedy-ingest-test\n", encoding="utf-8")

    result, args = _run(tmp_path, "--dev", BESEDY_INGEST_WORKER_ENV=str(env_file))

    assert result.returncode == 0, result.stderr
    assert args[args.index("--pool") + 1] == "besedy-ingest-test"


def test_unknown_argument_is_rejected(tmp_path: Path) -> None:
    result, args = _run(tmp_path, "--bogus")

    assert result.returncode == 2
    assert "Usage" in result.stderr
    assert args == []
