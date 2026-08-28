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
    (
        "mode",
        "override_var",
        "compose_overrides",
        "profile",
        "extra_profile",
        "app_env",
        "instance",
    ),
    [
        (
            "development",
            "BESEDY_WEB_ENV_DEV",
            ["docker-compose.dev.yml"],
            "mock-oauth",
            "tools",
            "development",
            "development",
        ),
        (
            "production",
            "BESEDY_WEB_ENV_PROD",
            ["docker-compose.secure.yml", "docker-compose.production.yml"],
            "backup",
            None,
            "production",
            "production",
        ),
        (
            "test",
            "BESEDY_WEB_ENV_TEST",
            ["docker-compose.secure.yml"],
            "mock-oauth",
            None,
            "test",
            "test",
        ),
    ],
)
def test_web_compose_wrapper_isolates_mode_and_forwards_resolved_env_file(
    tmp_path: Path,
    mode: str,
    override_var: str,
    compose_overrides: list[str],
    profile: str,
    extra_profile: str | None,
    app_env: str,
    instance: str,
) -> None:
    env_file = tmp_path / f"{mode}.env"
    env_file.write_text(f"APP_ENV={app_env}\nCONFIG_FILE=/safe/config.toml\n", encoding="utf-8")

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" config --format json "* ]]; then
  if [[ "$APP_ENV" == "production" ]]; then
    volume_source="besedy_production_postgres"
    external=true
  else
    volume_source="besedy_${BESEDY_COMPOSE_INSTANCE}_postgres"
    external=false
  fi
  volume_target="/var/lib/postgresql"
  printf '{"name":"%s","services":{"db":{"container_name":"%s-db","image":"pgvector/pgvector:pg18","volumes":[{"type":"volume","source":"postgres_data","target":"%s"}]},"web":{"container_name":"%s-web","environment":{"APP_ENV":"%s"}}},"volumes":{"postgres_data":{"name":"%s","external":%s}}}\n' \
    "$COMPOSE_PROJECT_NAME" "$COMPOSE_PROJECT_NAME" "$volume_target" \
    "$COMPOSE_PROJECT_NAME" "$APP_ENV" "$volume_source" "$external"
  exit 0
fi
printf 'APP_ENV=%s\n' "$APP_ENV"
printf 'BESEDY_COMPOSE_INSTANCE=%s\n' "$BESEDY_COMPOSE_INSTANCE"
printf 'COMPOSE_PROJECT_NAME=%s\n' "$COMPOSE_PROJECT_NAME"
printf 'CONFIG_FILE=%s\n' "${CONFIG_FILE-unset}"
printf '%s\n' "$@"
""",
        encoding="utf-8",
    )
    docker.chmod(0o755)

    env = os.environ.copy()
    env[override_var] = str(env_file)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    env["APP_ENV"] = "production"
    env["COMPOSE_PROJECT_NAME"] = "besedy-production"
    env["CONFIG_FILE"] = "/production/config.toml"

    command = ["bash", str(COMPOSE_WRAPPER), mode]
    if extra_profile:
        command.extend(["--profile", extra_profile])
    command.extend(["ps", "--format", "json"])
    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    expected_args = [
        f"APP_ENV={app_env}",
        f"BESEDY_COMPOSE_INSTANCE={instance}",
        f"COMPOSE_PROJECT_NAME=besedy-{instance}",
        "CONFIG_FILE=unset",
        "compose",
        "-f",
        "docker-compose.yml",
    ]
    for compose_override in compose_overrides:
        expected_args.extend(["-f", compose_override])
    expected_args.extend(["--profile", profile])
    if extra_profile:
        expected_args.extend(["--profile", extra_profile])
    expected_args.extend(
        [
            "--env-file",
            str(env_file),
            "ps",
            "--format",
            "json",
        ]
    )
    assert result.stdout.splitlines() == expected_args


def test_web_compose_wrapper_rejects_production_named_test_instance(tmp_path: Path) -> None:
    env_file = tmp_path / "test.env"
    env_file.write_text("APP_ENV=test\nCONFIG_FILE=/safe/config.toml\n", encoding="utf-8")
    env = os.environ.copy()
    env["BESEDY_WEB_ENV_TEST"] = str(env_file)
    env["BESEDY_WEB_COMPOSE_INSTANCE"] = "production"

    result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), "test", "ps"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert "Unsafe test Compose instance 'production'" in result.stderr


def test_web_compose_wrapper_rejects_wrong_mode_env_file(tmp_path: Path) -> None:
    env_file = tmp_path / "test.env"
    env_file.write_text("APP_ENV=production\nCONFIG_FILE=/safe/config.toml\n", encoding="utf-8")
    env = os.environ.copy()
    env["BESEDY_WEB_ENV_TEST"] = str(env_file)

    result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), "test", "ps"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert "APP_ENV is 'production', expected 'test'" in result.stderr


@pytest.mark.parametrize(
    "unsafe_args",
    [
        ["--project-name", "besedy-production", "config"],
        ["-pbesedy-production", "config"],
        ["--file=docker-compose.production.yml", "config"],
        ["-fdocker-compose.production.yml", "config"],
        ["--env-file", "/tmp/production.env", "config"],
        ["--project-directory=/tmp/production", "config"],
    ],
)
def test_web_compose_wrapper_rejects_resource_shaping_global_options(
    unsafe_args: list[str],
) -> None:
    result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), "test", *unsafe_args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert "Unsafe Docker Compose option" in result.stderr
