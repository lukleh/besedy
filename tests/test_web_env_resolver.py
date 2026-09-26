"""Tests for the web environment-file resolver."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
RESOLVER = REPO_ROOT / "scripts" / "resolve_web_env_file.sh"
COMPOSE_WRAPPER = REPO_ROOT / "scripts" / "run_web_compose.sh"
COMPOSE_VALIDATOR = REPO_ROOT / "scripts" / "validate_web_compose_config.sh"
KEY_CHECK = REPO_ROOT / "scripts" / "check_web_env_keys.sh"

# Every key the web Compose files require (${VAR:?...} or ${VAR?...}) apart from
# CONFIG_FILE, so wrapper tests get past the env-key check to the fake docker.
REQUIRED_COMPOSE_ENV = (
    "AUTH_SECRET=test-secret\n"
    "TEXT_DATA_DIR=/safe/text\n"
    "ARTWORK_DIR=/safe/artwork\n"
    "SOURCES_DIR=/safe/sources\n"
    "UPLOADS_DIR=/safe/uploads\n"
    "CORRECTIONS_DIR=/safe/corrections\n"
    "AUDIO_DIR=/safe/audio\n"
    "ORIGINAL_AUDIO_DIR=/safe/original\n"
)


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
    env_file.write_text(
        f"APP_ENV={app_env}\nCONFIG_FILE=/safe/config.toml\n{REQUIRED_COMPOSE_ENV}",
        encoding="utf-8",
    )

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
  printf '{"name":"%s","services":{"db":{"container_name":"%s-db","image":"pgvector/pgvector:pg18","networks":{"default":null},"volumes":[{"type":"volume","source":"postgres_data","target":"%s"}]},"web":{"container_name":"%s-web","environment":{"APP_ENV":"%s"},"networks":{"besedy_internal":null,"default":null}}},"volumes":{"postgres_data":{"name":"%s","external":%s}},"networks":{"default":{"name":"%s_default"},"besedy_internal":{"name":"%s","external":true}}}\n' \
    "$COMPOSE_PROJECT_NAME" "$COMPOSE_PROJECT_NAME" "$volume_target" \
    "$COMPOSE_PROJECT_NAME" "$APP_ENV" "$volume_source" "$external" \
    "$COMPOSE_PROJECT_NAME" "$BESEDY_INTERNAL_NETWORK"
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


def compose_config(
    mode: str,
    *,
    internal_network: str = "besedy-internal",
    db_networks: dict[str, None] | None = None,
    config_file: str = "/safe/config.toml",
    jobs_api_base_url: str | None = None,
) -> dict[str, object]:
    instance = mode
    volume_name = (
        "besedy_production_postgres"
        if mode == "production"
        else f"besedy_{instance}_postgres"
    )
    web_environment: dict[str, str] = {"APP_ENV": mode, "CONFIG_FILE": config_file}
    if jobs_api_base_url is not None:
        web_environment["JOBS_API_BASE_URL"] = jobs_api_base_url
    return {
        "name": f"besedy-{instance}",
        "services": {
            "db": {
                "container_name": f"besedy-{instance}-db",
                "image": "pgvector/pgvector:pg18",
                "networks": db_networks or {"default": None},
                "volumes": [
                    {
                        "type": "volume",
                        "source": "postgres_data",
                        "target": "/var/lib/postgresql",
                    }
                ],
            },
            "web": {
                "container_name": f"besedy-{instance}-web",
                "environment": web_environment,
                "networks": {"besedy_internal": None, "default": None},
            },
        },
        "volumes": {
            "postgres_data": {
                "name": volume_name,
                "external": mode == "production",
            }
        },
        "networks": {
            "default": {"name": f"besedy-{instance}_default"},
            "besedy_internal": {"name": internal_network, "external": True},
        },
    }


def validate_compose_config(config: dict[str, object], mode: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(COMPOSE_VALIDATOR), mode, mode, "besedy-internal"],
        cwd=REPO_ROOT,
        input=json.dumps(config),
        capture_output=True,
        text=True,
        check=False,
    )


def test_compose_validator_allows_production_text_in_non_resource_paths() -> None:
    config = compose_config(
        "test", config_file="/tmp/besedy-production-fixtures/config.toml"
    )

    result = validate_compose_config(config, "test")

    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    ("mode", "config", "message"),
    [
        (
            "production",
            compose_config("production", internal_network="besedy-test_default"),
            "internal network is 'besedy-test_default'",
        ),
        (
            "test",
            compose_config(
                "test", db_networks={"besedy_internal": None, "default": None}
            ),
            "database must only join the project default network",
        ),
    ],
)
def test_compose_validator_rejects_cross_environment_networks(
    mode: str, config: dict[str, object], message: str
) -> None:
    result = validate_compose_config(config, mode)

    assert result.returncode == 1
    assert message in result.stderr


def _fake_docker_with_binds(bin_dir: Path, config: dict[str, object]) -> None:
    bin_dir.mkdir()
    config_file = bin_dir / "rendered.json"
    config_file.write_text(json.dumps(config), encoding="utf-8")
    docker = bin_dir / "docker"
    docker.write_text(
        f"""#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" config --format json "* ]]; then
  cat {config_file}
  exit 0
fi
printf 'BESEDY_HOST_UID=%s\\n' "${{BESEDY_HOST_UID-unset}}"
printf 'BESEDY_HOST_GID=%s\\n' "${{BESEDY_HOST_GID-unset}}"
""",
        encoding="utf-8",
    )
    docker.chmod(0o755)


def _bind_config(mode: str, root: Path) -> dict[str, object]:
    instance = {"development": "development", "test": "test", "production": "production"}[mode]
    project = f"besedy-{instance}"
    volume_name = (
        "besedy_production_postgres" if mode == "production" else f"besedy_{instance}_postgres"
    )
    return {
        "name": project,
        "services": {
            "db": {
                "container_name": f"{project}-db",
                "image": "pgvector/pgvector:pg18",
                "networks": {"default": None},
                "volumes": [
                    {"type": "volume", "source": "postgres_data", "target": "/var/lib/postgresql"}
                ],
            },
            "web": {
                "container_name": f"{project}-web",
                "environment": {"APP_ENV": mode},
                "networks": {"besedy_internal": None, "default": None},
                "volumes": [
                    {"type": "bind", "source": str(root / "checkout"), "target": "/app"},
                    {"type": "volume", "target": "/app/node_modules"},
                    {
                        "type": "bind",
                        "source": str(root / "checkout/missing-file.toml"),
                        "target": "/app/missing-file.toml",
                    },
                    {"type": "bind", "source": str(root / "cache/.next"), "target": "/app/.cache-next"},
                    {"type": "bind", "source": str(root / "state/logs"), "target": "/var/log/besedy"},
                    {"type": "bind", "source": str(root / "fixtures"), "target": "/data/text"},
                    {"type": "bind", "source": str(root / "uploads"), "target": "/data/uploads"},
                    {"type": "bind", "source": str(root / "corrections"), "target": "/data/corrections"},
                    {
                        "type": "bind",
                        "source": str(root / "missing.toml"),
                        "target": "/data/config/besedy.docker.toml",
                    },
                ],
            },
        },
        "volumes": {"postgres_data": {"name": volume_name, "external": mode == "production"}},
        "networks": {
            "default": {"name": f"{project}_default"},
            "besedy_internal": {"name": "besedy-internal", "external": True},
        },
    }


@pytest.mark.parametrize(
    ("mode", "override_var"),
    [("development", "BESEDY_WEB_ENV_DEV"), ("test", "BESEDY_WEB_ENV_TEST")],
)
def test_web_compose_wrapper_creates_missing_directory_mounts_as_the_invoking_user(
    tmp_path: Path, mode: str, override_var: str
) -> None:
    root = tmp_path / "host"
    (root / "checkout").mkdir(parents=True)
    env_file = tmp_path / f"{mode}.env"
    env_file.write_text(
        f"APP_ENV={mode}\nCONFIG_FILE=/safe/config.toml\n{REQUIRED_COMPOSE_ENV}",
        encoding="utf-8",
    )
    bin_dir = tmp_path / "bin"
    _fake_docker_with_binds(bin_dir, _bind_config(mode, root))

    env = os.environ.copy()
    env[override_var] = str(env_file)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), mode, "up", "-d"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    created = [
        root / "cache/.next",
        root / "state/logs",
        root / "fixtures",
        root / "uploads",
        root / "corrections",
        root / "checkout/node_modules",
        root / "checkout/.cache-next",
    ]
    for path in created:
        assert path.is_dir(), path
        assert path.stat().st_uid == os.getuid(), path
    assert not (root / "missing.toml").exists()
    assert not (root / "checkout/missing-file.toml").exists()
    assert f"BESEDY_HOST_UID={os.getuid()}" in result.stdout
    assert f"BESEDY_HOST_GID={os.getgid()}" in result.stdout


def test_web_compose_wrapper_leaves_production_directory_mounts_to_the_operator(
    tmp_path: Path,
) -> None:
    root = tmp_path / "host"
    (root / "checkout").mkdir(parents=True)
    config = tmp_path / "besedy.container.toml"
    config.write_text("[paths]\n", encoding="utf-8")
    config.chmod(0o644)
    env_file = tmp_path / "production.env"
    env_file.write_text(
        "APP_ENV=production\n"
        f"CONFIG_FILE={config}\n"
        "CONFIG_MOUNT=/data/config/besedy.toml\n"
        "BESEDY_CONFIG=/data/config/besedy.toml\n"
        f"{REQUIRED_COMPOSE_ENV}",
        encoding="utf-8",
    )
    bin_dir = tmp_path / "bin"
    _fake_docker_with_binds(bin_dir, _bind_config("production", root))

    env = os.environ.copy()
    env["BESEDY_WEB_ENV_PROD"] = str(env_file)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), "production", "up", "-d"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert not (root / "state/logs").exists()
    assert not (root / "checkout/node_modules").exists()


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_web_compose_wrapper_warns_instead_of_failing_when_a_mount_cannot_be_created(
    tmp_path: Path,
) -> None:
    root = tmp_path / "host"
    (root / "checkout").mkdir(parents=True)
    locked = tmp_path / "locked"
    locked.mkdir()
    config = _bind_config("development", root)
    config["services"]["web"]["volumes"].append(  # type: ignore[index]
        {"type": "bind", "source": str(locked / "nas/original"), "target": "/data/original"}
    )
    env_file = tmp_path / "development.env"
    env_file.write_text(
        f"APP_ENV=development\nCONFIG_FILE=/safe/config.toml\n{REQUIRED_COMPOSE_ENV}",
        encoding="utf-8",
    )
    bin_dir = tmp_path / "bin"
    _fake_docker_with_binds(bin_dir, config)

    env = os.environ.copy()
    env["BESEDY_WEB_ENV_DEV"] = str(env_file)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    locked.chmod(0o555)
    try:
        result = subprocess.run(
            ["bash", str(COMPOSE_WRAPPER), "development", "up", "-d"],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        locked.chmod(0o755)

    assert result.returncode == 0, result.stderr
    assert f"Warning: could not create {locked / 'nas/original'}" in result.stderr
    assert (root / "state/logs").is_dir()


@pytest.mark.parametrize(
    ("mode", "override_var", "jobs_api_host"),
    [
        ("development", "BESEDY_WEB_ENV_DEV", "besedy-dev-jobs-api"),
        ("test", "BESEDY_WEB_ENV_TEST", "besedy-test-jobs-api"),
        ("production", "BESEDY_WEB_ENV_PROD", "besedy-prod-jobs-api"),
    ],
)
def test_web_compose_wrapper_points_web_at_its_own_jobs_runtime(
    tmp_path: Path, mode: str, override_var: str, jobs_api_host: str
) -> None:
    env_file = tmp_path / f"{mode}.env"
    env_file.write_text(
        f"APP_ENV={mode}\nCONFIG_FILE=/safe/config.toml\n{REQUIRED_COMPOSE_ENV}",
        encoding="utf-8",
    )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    config_file = bin_dir / "rendered.json"
    config_file.write_text(json.dumps(compose_config(mode)), encoding="utf-8")
    docker = bin_dir / "docker"
    docker.write_text(
        f"""#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" config --format json "* ]]; then
  cat {config_file}
  exit 0
fi
printf 'BESEDY_JOBS_API_HOST=%s\\n' "${{BESEDY_JOBS_API_HOST-unset}}"
""",
        encoding="utf-8",
    )
    docker.chmod(0o755)

    env = os.environ.copy()
    env[override_var] = str(env_file)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    # An inherited value must not leak into the clean Compose environment.
    env["BESEDY_JOBS_API_HOST"] = "besedy-prod-jobs-api"
    result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), mode, "ps"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == f"BESEDY_JOBS_API_HOST={jobs_api_host}"


@pytest.mark.parametrize(
    ("mode", "jobs_api_base_url", "message"),
    [
        (
            "production",
            "http://jobs-api:8390",
            "shared by every jobs runtime on besedy-internal; unset it in the env file to use "
            "http://besedy-prod-jobs-api:8390",
        ),
        (
            "development",
            "http://jobs-api:8390/",
            "unset it in the env file to use http://besedy-dev-jobs-api:8390",
        ),
        (
            "test",
            "http://besedy-jobs-api:8390",
            "names the development jobs runtime; use http://besedy-test-jobs-api:8390",
        ),
        (
            "development",
            "http://besedy-prod-jobs-api:8390",
            "names another environment's jobs runtime; use http://besedy-dev-jobs-api:8390",
        ),
        (
            "production",
            "http://besedy-test-jobs-api:8390/",
            "names another environment's jobs runtime; use http://besedy-prod-jobs-api:8390",
        ),
    ],
)
def test_compose_validator_rejects_jobs_api_names_of_other_runtimes(
    mode: str, jobs_api_base_url: str, message: str
) -> None:
    result = validate_compose_config(
        compose_config(mode, jobs_api_base_url=jobs_api_base_url), mode
    )

    assert result.returncode == 1
    assert message in result.stderr


@pytest.mark.parametrize(
    ("mode", "jobs_api_base_url"),
    [
        ("production", "http://besedy-prod-jobs-api:8390"),
        ("test", "http://besedy-test-jobs-api:8390"),
        ("development", "http://besedy-jobs-api:8390"),
        ("development", "http://host.docker.internal:8390"),
        ("production", "https://jobs.example.internal/"),
        ("test", None),
    ],
)
def test_compose_validator_accepts_a_jobs_api_that_names_its_own_runtime(
    mode: str, jobs_api_base_url: str | None
) -> None:
    result = validate_compose_config(
        compose_config(mode, jobs_api_base_url=jobs_api_base_url), mode
    )

    assert result.returncode == 0, result.stderr


def test_web_compose_wrapper_lists_every_missing_required_key_before_compose(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / "production.env"
    env_file.write_text("APP_ENV=production\nSTALE_SECRET=do-not-print\n", encoding="utf-8")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    marker = tmp_path / "compose-ran"
    docker = bin_dir / "docker"
    docker.write_text(f"#!/usr/bin/env bash\ntouch {marker}\n", encoding="utf-8")
    docker.chmod(0o755)

    env = os.environ.copy()
    env["BESEDY_WEB_ENV_PROD"] = str(env_file)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), "production", "ps"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert not marker.exists()
    assert (
        "missing keys its Compose files require: ARTWORK_DIR AUDIO_DIR AUTH_SECRET "
        "CONFIG_FILE CORRECTIONS_DIR ORIGINAL_AUDIO_DIR SOURCES_DIR TEXT_DATA_DIR UPLOADS_DIR"
    ) in result.stderr
    assert str(REPO_ROOT / "web" / ".env.prod.example") in result.stderr
    assert "do-not-print" not in result.stderr


@pytest.mark.parametrize(("command", "warns"), [(["up", "-d"], True), (["ps"], False)])
def test_web_compose_wrapper_warns_about_unused_keys_only_when_changing_resources(
    tmp_path: Path,
    command: list[str],
    warns: bool,
) -> None:
    root = tmp_path / "host"
    (root / "checkout").mkdir(parents=True)
    env_file = tmp_path / "test.env"
    env_file.write_text(
        "APP_ENV=test\nCONFIG_FILE=/safe/config.toml\n"
        f"{REQUIRED_COMPOSE_ENV}POSTERS_DIR=/old/posters\n",
        encoding="utf-8",
    )
    bin_dir = tmp_path / "bin"
    _fake_docker_with_binds(bin_dir, _bind_config("test", root))

    env = os.environ.copy()
    env["BESEDY_WEB_ENV_TEST"] = str(env_file)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), "test", *command],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert ("POSTERS_DIR" in result.stderr) is warns
    if warns:
        assert "renamed or removed?" in result.stderr
        assert str(REPO_ROOT / "web" / ".env.test.example") in result.stderr
    assert "/old/posters" not in result.stderr


def _run_key_check(
    tmp_path: Path,
    env_text: str,
    *,
    template_text: str = "",
    compose_text: str = "services: {}\n",
    provided: str = "",
    action: str = "check",
) -> subprocess.CompletedProcess[str]:
    env_file = tmp_path / "web.env"
    env_file.write_text(env_text, encoding="utf-8")
    template = tmp_path / ".env.example"
    template.write_text(template_text, encoding="utf-8")
    compose = tmp_path / "docker-compose.yml"
    compose.write_text(compose_text, encoding="utf-8")
    options = ["true"] if action == "check" else []
    return subprocess.run(
        [
            "bash",
            str(KEY_CHECK),
            action,
            "test",
            str(env_file),
            str(template),
            provided,
            *options,
            str(compose),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def test_key_check_knows_commented_template_keys_and_compose_references(
    tmp_path: Path,
) -> None:
    result = _run_key_check(
        tmp_path,
        "OPTIONAL_KEY=1\nexport  WEB_LOGS_DIR = /logs\nGONE_KEY=secret-value\n",
        template_text="# OPTIONAL_KEY=value\n",
        compose_text="x: ${WEB_LOGS_DIR:-/default}\n",
    )

    assert result.returncode == 0
    assert "GONE_KEY" in result.stderr
    assert "OPTIONAL_KEY" not in result.stderr
    assert "WEB_LOGS_DIR" not in result.stderr
    assert "secret-value" not in result.stderr


def test_key_check_ignores_keys_the_caller_provides(tmp_path: Path) -> None:
    result = _run_key_check(
        tmp_path,
        "",
        compose_text="a: ${APP_ENV:?required}\nb: ${GIT_COMMIT?required}\n",
        provided="APP_ENV GIT_COMMIT",
    )

    assert result.returncode == 0, result.stderr


def test_key_check_applies_compose_required_semantics(tmp_path: Path) -> None:
    compose_text = (
        "a: ${NONEMPTY:?required}\n"
        "b: ${SET_ONLY?required}\n"
        "c: ${OUTER:-${NESTED:?only when OUTER is unset}}\n"
        "# d: ${COMMENTED:?not interpolated}\n"
        "e: $${ESCAPED:?literal}\n"
    )

    empty = _run_key_check(tmp_path, "NONEMPTY=''\nSET_ONLY=\n", compose_text=compose_text)
    assert empty.returncode == 1
    assert "require: NONEMPTY\n" in empty.stderr

    filled = _run_key_check(
        tmp_path, "NONEMPTY=value # comment\nSET_ONLY=\n", compose_text=compose_text
    )
    assert filled.returncode == 0, filled.stderr


def test_key_check_report_prints_the_full_comparison(tmp_path: Path) -> None:
    result = _run_key_check(
        tmp_path,
        "SET_KEY=1\nOLD_KEY=secret-value\n",
        template_text="SET_KEY=\nUNSET_KEY=\n# COMMENTED_KEY=\n",
        compose_text="a: ${REQUIRED_KEY:?required}\nb: ${SET_KEY}\n",
        action="report",
    )

    assert result.returncode == 1
    assert "Missing required keys: REQUIRED_KEY\n" in result.stdout
    assert "Optional template keys not set: UNSET_KEY\n" in result.stdout
    assert "Keys no Compose file or the template uses: OLD_KEY\n" in result.stdout
    assert "secret-value" not in result.stdout
