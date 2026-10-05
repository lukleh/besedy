"""scripts/check_prefect_server_version.sh against a stubbed docker."""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT_ROOT / "scripts" / "check_prefect_server_version.sh"
_PIN_MATCH = re.search(
    r'"prefect(?:\[[^\]"]*\])?==(\d+\.\d+\.\d+)"',
    (PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8"),
)
assert _PIN_MATCH is not None
PIN = _PIN_MATCH.group(1)

# `docker compose ... config` prints a minimal config whose prefect-server image
# is FAKE_SERVER_IMAGE (no image line when empty); `... exec ...` prints
# FAKE_RUNNING or fails with FAKE_EXEC_ERROR, as a stopped container does.
DOCKER_STUB = """#!/usr/bin/env bash
case " $* " in
  *" config "*)
    printf 'services:\\n  prefect-postgres:\\n    image: postgres:17-alpine\\n  prefect-server:\\n'
    [[ -z "$FAKE_SERVER_IMAGE" ]] || printf '    image: %s\\n' "$FAKE_SERVER_IMAGE"
    printf '    command:\\n      - prefect\\n  prefect-services:\\n    image: other:1\\n'
    ;;
  *" exec "*)
    if [[ -n "${FAKE_EXEC_ERROR:-}" ]]; then
      echo "$FAKE_EXEC_ERROR" >&2
      exit 1
    fi
    echo "$FAKE_RUNNING"
    ;;
  *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
"""


def _run(tmp_path: Path, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(DOCKER_STUB, encoding="utf-8")
    docker.chmod(0o755)
    env_file = tmp_path / "jobs.env.prefect"
    env_file.write_text("", encoding="utf-8")
    full_env = {
        **{k: v for k, v in os.environ.items() if not k.startswith(("BESEDY_", "PREFECT_"))},
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "BESEDY_JOBS_ENV_PREFECT": str(env_file),
        "FAKE_SERVER_IMAGE": f"prefecthq/prefect:{PIN}-python3.13",
        "FAKE_RUNNING": PIN,
        **env,
    }
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        cwd=PROJECT_ROOT,
        env=full_env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_matching_image_passes(tmp_path: Path) -> None:
    result = _run(tmp_path)

    assert result.returncode == 0, result.stderr
    assert f"prefecthq/prefect:{PIN}-python3.13" in result.stdout


def test_overridden_image_fails_and_names_both_versions(tmp_path: Path) -> None:
    result = _run(tmp_path, FAKE_SERVER_IMAGE="prefecthq/prefect:3.6.21-python3.13")

    assert result.returncode == 1
    assert "MISMATCH" in result.stderr
    assert PIN in result.stdout + result.stderr
    assert "3.6.21" in result.stdout + result.stderr


def test_non_version_tag_is_a_mismatch(tmp_path: Path) -> None:
    result = _run(tmp_path, FAKE_SERVER_IMAGE="prefecthq/prefect:3-latest")

    assert result.returncode == 1
    assert "MISMATCH" in result.stderr


@pytest.mark.parametrize(
    "image",
    [
        f"registry.local/prefect:{PIN}-python3.13@sha256:" + "0" * 64,
        f"prefecthq/prefect:{PIN}-rc1-python3.13",
        f"prefecthq/prefect:{PIN}-custom",
    ],
)
def test_image_without_a_comparable_version_is_a_mismatch(tmp_path: Path, image: str) -> None:
    result = _run(tmp_path, FAKE_SERVER_IMAGE=image)

    assert result.returncode == 1
    assert "MISMATCH" in result.stderr


def test_opt_out_accepts_a_mirrored_digest_image(tmp_path: Path) -> None:
    result = _run(
        tmp_path,
        FAKE_SERVER_IMAGE="registry.local/prefecthq-prefect@sha256:" + "0" * 64,
        BESEDY_ALLOW_PREFECT_VERSION_DRIFT="1",
    )

    assert result.returncode == 0
    assert "WARNING" in result.stderr


def test_script_and_justfile_use_the_same_compose_file() -> None:
    justfile = (PROJECT_ROOT / "Justfile").read_text(encoding="utf-8")
    prefect_compose = re.search(r"^prefect_compose := (.*)$", justfile, re.MULTILINE)

    assert prefect_compose is not None
    compose_files = re.findall(r"-f (\S+?)\\?\"?(?:\s|$)", prefect_compose.group(1))
    assert compose_files == ["jobs-service/docker-compose.prefect.yml"]
    assert "-f jobs-service/docker-compose.prefect.yml" in SCRIPT.read_text(encoding="utf-8")


def test_opt_out_downgrades_drift_to_a_warning(tmp_path: Path) -> None:
    result = _run(
        tmp_path,
        FAKE_SERVER_IMAGE="prefecthq/prefect:3.6.21-python3.13",
        BESEDY_ALLOW_PREFECT_VERSION_DRIFT="1",
    )

    assert result.returncode == 0
    assert "MISMATCH" in result.stderr
    assert "WARNING" in result.stderr


def test_missing_server_image_is_an_error(tmp_path: Path) -> None:
    result = _run(tmp_path, FAKE_SERVER_IMAGE="")

    assert result.returncode == 1
    assert "No prefect-server image" in result.stderr


def test_running_server_matching_the_pin_passes(tmp_path: Path) -> None:
    result = _run(tmp_path, "--running")

    assert result.returncode == 0, result.stderr
    assert f"Prefect server (running):            {PIN}" in result.stdout


def test_running_server_drift_fails(tmp_path: Path) -> None:
    result = _run(tmp_path, "--running", FAKE_RUNNING="3.6.21")

    assert result.returncode == 1
    assert "MISMATCH: running server 3.6.21" in result.stderr


def test_exec_failure_shows_the_real_error_not_not_running(tmp_path: Path) -> None:
    result = _run(tmp_path, "--running", FAKE_EXEC_ERROR="service prefect-server is restarting")

    assert result.returncode == 1
    assert "service prefect-server is restarting" in result.stderr
    assert "not running" not in result.stdout


def test_unknown_argument_is_rejected(tmp_path: Path) -> None:
    result = _run(tmp_path, "--bogus")

    assert result.returncode == 2
    assert "Usage" in result.stderr


def _has_docker_compose() -> bool:
    return (
        shutil.which("docker") is not None
        and subprocess.run(
            ["docker", "compose", "version"], capture_output=True, check=False
        ).returncode
        == 0
    )


@pytest.mark.skipif(not _has_docker_compose(), reason="requires docker compose")
def test_real_compose_config_resolves_a_host_override(tmp_path: Path) -> None:
    env_file = tmp_path / "jobs.env.prefect"
    env_file.write_text("PREFECT_IMAGE=prefecthq/prefect:3.6.21-python3.13\n", encoding="utf-8")
    result = subprocess.run(
        ["bash", str(SCRIPT)],
        cwd=PROJECT_ROOT,
        env={
            **{
                k: v
                for k, v in os.environ.items()
                if not k.startswith(("BESEDY_", "PREFECT_"))
            },
            "BESEDY_JOBS_ENV_PREFECT": str(env_file),
        },
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert "MISMATCH" in result.stderr
    assert "3.6.21" in result.stdout
