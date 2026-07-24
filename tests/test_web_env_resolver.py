"""Tests for the web environment-file resolver."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
RESOLVER = REPO_ROOT / "scripts" / "resolve_web_env_file.sh"
COMPOSE_WRAPPER = REPO_ROOT / "scripts" / "run_web_compose.sh"


@pytest.mark.parametrize(
    ("mode", "override_var", "example_name", "config_name"),
    [
        ("development", "BESEDY_WEB_ENV_DEV", ".env.dev.example", "web.env.dev"),
        ("production", "BESEDY_WEB_ENV_PROD", ".env.prod.example", "web.env.prod"),
        ("test", "BESEDY_WEB_ENV_TEST", ".env.test.example", "web.env.test"),
    ],
)
def test_missing_web_env_file_has_actionable_error(
    tmp_path: Path,
    mode: str,
    override_var: str,
    example_name: str,
    config_name: str,
) -> None:
    env = os.environ.copy()
    env["XDG_CONFIG_HOME"] = str(tmp_path / "config")
    env.pop("BESEDY_WEB_ENV_DEV", None)
    env.pop("BESEDY_WEB_ENV_PROD", None)
    env.pop("BESEDY_WEB_ENV_TEST", None)

    result = subprocess.run(
        ["bash", str(RESOLVER), mode],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert override_var in result.stderr
    assert str(REPO_ROOT / "web" / example_name) in result.stderr
    assert str(tmp_path / "config" / "lukleh" / "besedy" / config_name) in result.stderr

    wrapper_result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), mode, "ps"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert wrapper_result.returncode == 1
    assert wrapper_result.stderr == result.stderr


@pytest.mark.parametrize(
    ("mode", "override_var", "compose_override", "profile"),
    [
        ("development", "BESEDY_WEB_ENV_DEV", "docker-compose.dev.yml", "mock-oauth"),
        ("production", "BESEDY_WEB_ENV_PROD", "docker-compose.secure.yml", "backup"),
        ("test", "BESEDY_WEB_ENV_TEST", "docker-compose.secure.yml", "mock-oauth"),
    ],
)
def test_web_compose_wrapper_forwards_resolved_env_file(
    tmp_path: Path,
    mode: str,
    override_var: str,
    compose_override: str,
    profile: str,
) -> None:
    env_file = tmp_path / f"{mode}.env"
    env_file.write_text("APP_ENV=test\n", encoding="utf-8")

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', encoding="utf-8")
    docker.chmod(0o755)

    env = os.environ.copy()
    env[override_var] = str(env_file)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"

    result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), mode, "ps", "--format", "json"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        "compose",
        "-f",
        "docker-compose.yml",
        "-f",
        compose_override,
        "--profile",
        profile,
        "--env-file",
        str(env_file),
        "ps",
        "--format",
        "json",
    ]
