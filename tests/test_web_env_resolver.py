"""Tests for the web environment-file resolver."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
RESOLVER = REPO_ROOT / "scripts" / "resolve_web_env_file.sh"
COMPOSE_WRAPPER = REPO_ROOT / "scripts" / "run_web_compose.sh"
COMPOSE_VALIDATOR = REPO_ROOT / "scripts" / "validate_web_compose_config.sh"
KEY_CHECK = REPO_ROOT / "scripts" / "check_web_env_keys.sh"


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
    env_file.write_text(f"APP_ENV={mode}\n", encoding="utf-8")
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
        "BESEDY_CONFIG=/data/config/besedy.toml\n",
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
    env_file.write_text("APP_ENV=development\n", encoding="utf-8")
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
    env_file.write_text(f"APP_ENV={mode}\nCONFIG_FILE=/safe/config.toml\n", encoding="utf-8")
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


def test_resolver_prints_the_mode_template_with_the_template_option() -> None:
    for mode, example_name in (
        ("development", ".env.dev.example"),
        ("production", ".env.prod.example"),
        ("test", ".env.test.example"),
    ):
        result = subprocess.run(
            ["bash", str(RESOLVER), mode, "--template"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert result.stdout == f"{REPO_ROOT / 'web' / example_name}\n"


def test_scripts_the_compose_wrapper_runs_directly_are_executable_in_git() -> None:
    # core.fileMode=false hides a missing executable bit locally, and every
    # wrapper call then fails with "Permission denied" on a fresh checkout.
    in_git = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if in_git.returncode != 0:
        pytest.skip("not a git checkout")
    wrapper = COMPOSE_WRAPPER.read_text(encoding="utf-8")
    scripts = sorted(set(re.findall(r'"\$script_dir/([A-Za-z0-9_.-]+\.sh)"', wrapper)))
    assert "check_web_env_keys.sh" in scripts

    listed = subprocess.run(
        ["git", "ls-files", "-s", "--", *(f"scripts/{name}" for name in scripts)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    modes = {line.split("\t")[1]: line.split()[0] for line in listed}

    assert modes == {f"scripts/{name}": "100755" for name in scripts}


SENTINEL = "SENTINEL-VALUE-5f3a"


def _variables(*required: str, optional: tuple[str, ...] = ()) -> dict[str, dict[str, object]]:
    return {
        name: {"Name": name, "DefaultValue": "", "PresenceValue": "", "Required": name in required}
        for name in (*required, *optional)
    }


def _fake_docker_for_key_checks(
    bin_dir: Path,
    variables: dict[str, dict[str, object]],
    environment: dict[str, str],
    rendered: dict[str, object] | None = None,
) -> Path:
    """Fake docker that logs every call.

    `-f - ... config --format json` is the env-file parse, answered with
    `environment` as Compose would render the env_file of the minimal service.
    For the mode's own Compose files, `config --format json` prints `rendered`
    and `config --quiet` succeeds, or both fail the way Compose does on a
    missing required variable when `rendered` is None. `config --variables
    --format json` prints `variables`.
    """
    bin_dir.mkdir()
    calls = bin_dir / "calls.log"
    variables_file = bin_dir / "variables.json"
    variables_file.write_text(json.dumps(variables), encoding="utf-8")
    environment_file = bin_dir / "environment.json"
    environment_file.write_text(
        json.dumps({"services": {"envcheck": {"environment": environment}}}), encoding="utf-8"
    )
    rendered_file = bin_dir / "rendered.json"
    if rendered is not None:
        rendered_file.write_text(json.dumps(rendered), encoding="utf-8")
    docker = bin_dir / "docker"
    docker.write_text(
        f"""#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> {calls}
if [[ " $* " == *" -f - "* ]]; then
  cat > /dev/null
  cat {environment_file}
  exit 0
fi
if [[ " $* " == *" config --variables --format json "* ]]; then
  cat {variables_file}
  exit 0
fi
if [[ " $* " == *" config --format json "* || " $* " == *" config --quiet "* ]]; then
  if [[ -f {rendered_file} ]]; then
    [[ " $* " == *" --quiet "* ]] || cat {rendered_file}
    exit 0
  fi
  echo "required variable CONFIG_FILE is missing a value: CONFIG_FILE is required" >&2
  exit 15
fi
""",
        encoding="utf-8",
    )
    docker.chmod(0o755)
    return calls


def _compose_calls(calls: Path) -> list[str]:
    return [
        "env-file parse" if " -f - " in f" {line} " else line.split(" config ", 1)[-1]
        for line in calls.read_text(encoding="utf-8").splitlines()
    ]


def test_web_compose_wrapper_lists_every_missing_required_key_after_compose_fails(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / "production.env"
    env_file.write_text(
        f'APP_ENV=production\nREQUIRED_EMPTY="" # note\nSTALE_SECRET={SENTINEL}\n',
        encoding="utf-8",
    )
    calls = _fake_docker_for_key_checks(
        tmp_path / "bin",
        _variables(
            "APP_ENV", "COMPOSE_PROJECT_NAME", "CONFIG_FILE", "REQUIRED_EMPTY", "REQUIRED_SET"
        ),
        # As Compose's dotenv parser reads the file.
        {
            "APP_ENV": "production",
            "REQUIRED_EMPTY": "",
            "REQUIRED_SET": SENTINEL,
            "STALE_SECRET": SENTINEL,
        },
    )

    env = os.environ.copy()
    env["BESEDY_WEB_ENV_PROD"] = str(env_file)
    env["PATH"] = f"{tmp_path / 'bin'}{os.pathsep}{env['PATH']}"
    result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), "production", "ps"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    # Compose's own verdict and exit status stand; the wrapper only adds the list.
    assert result.returncode == 15
    assert "required variable CONFIG_FILE is missing a value" in result.stderr
    assert (
        "leaves unset or empty keys its Compose files require: CONFIG_FILE REQUIRED_EMPTY\n"
    ) in result.stderr
    assert str(REPO_ROOT / "web" / ".env.prod.example") in result.stderr
    assert SENTINEL not in result.stdout + result.stderr
    assert _compose_calls(calls) == ["--format json", "--variables --format json", "env-file parse"]


@pytest.mark.parametrize(
    ("command", "warns"),
    [(["up", "-d"], True), (["scale", "web=2"], True), (["ps"], False)],
)
def test_web_compose_wrapper_warns_about_unused_keys_only_when_changing_resources(
    tmp_path: Path,
    command: list[str],
    warns: bool,
) -> None:
    root = tmp_path / "host"
    (root / "checkout").mkdir(parents=True)
    env_file = tmp_path / "test.env"
    env_file.write_text(
        "APP_ENV=test\n"
        f"POSTERS_DIR={SENTINEL}\n"
        # Commented out in web/.env.test.example.
        "VAPID_PUBLIC_KEY=public\n"
        # Used by the Compose files but not in the template.
        "COMPOSE_ONLY_KEY=value\n"
        # Used only by another key of the same file.
        "SOURCE=ready\n"
        "AUTH_SECRET=${SOURCE}\n",
        encoding="utf-8",
    )
    calls = _fake_docker_for_key_checks(
        tmp_path / "bin",
        _variables("AUTH_SECRET", optional=("APP_ENV", "COMPOSE_ONLY_KEY")),
        {
            "APP_ENV": "test",
            "AUTH_SECRET": "ready",
            "COMPOSE_ONLY_KEY": "value",
            "POSTERS_DIR": SENTINEL,
            "SOURCE": "ready",
            "VAPID_PUBLIC_KEY": "public",
        },
        rendered=_bind_config("test", root),
    )

    env = os.environ.copy()
    env["BESEDY_WEB_ENV_TEST"] = str(env_file)
    env["PATH"] = f"{tmp_path / 'bin'}{os.pathsep}{env['PATH']}"
    result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), "test", *command],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    if warns:
        assert (
            "sets keys no Compose file, the template, or another key uses "
            "(renamed or removed?): POSTERS_DIR\n"
        ) in result.stderr
        assert str(REPO_ROOT / "web" / ".env.test.example") in result.stderr
    else:
        assert "renamed or removed?" not in result.stderr
    assert SENTINEL not in result.stdout + result.stderr
    # Commands that leave containers alone make no extra Compose call.
    expected = ["--format json"]
    if warns:
        expected += ["--variables --format json", "env-file parse"]
    assert _compose_calls(calls)[: len(expected)] == expected
    assert ("--variables" in calls.read_text(encoding="utf-8")) is warns


def _run_key_check(
    tmp_path: Path,
    variables: dict[str, dict[str, object]],
    facts: dict[str, str],
    *,
    env_text: str = "",
    template_text: str = "",
    provided: str = "",
    action: str = "report",
    compose_status: int = 0,
) -> subprocess.CompletedProcess[str]:
    env_file = tmp_path / "web.env"
    env_file.write_text(env_text, encoding="utf-8")
    template = tmp_path / ".env.example"
    template.write_text(template_text, encoding="utf-8")
    fact_words = " ".join(f"{name}={state}" for name, state in facts.items())
    return subprocess.run(
        [
            str(KEY_CHECK),
            action,
            "test",
            str(env_file),
            str(template),
            provided,
            fact_words,
            str(compose_status),
        ],
        input=json.dumps(variables),
        capture_output=True,
        text=True,
        check=False,
    )


def test_key_check_counts_a_key_set_from_another_key_as_set(tmp_path: Path) -> None:
    # SOURCE=ready and AUTH_SECRET=${SOURCE}: Compose resolves the reference
    # and accepts the file, so nothing is missing and SOURCE is in use.
    result = _run_key_check(
        tmp_path,
        _variables("AUTH_SECRET"),
        {"AUTH_SECRET": "set", "SOURCE": "set"},
        env_text="SOURCE=ready\nAUTH_SECRET=${SOURCE}\n",
    )

    assert result.returncode == 0, result.stdout
    assert "Compose: accepts this env file\n" in result.stdout
    assert "Missing or empty required keys: none\n" in result.stdout
    assert "Keys no Compose file, the template, or another key uses: none\n" in result.stdout


def test_key_check_report_prints_the_full_comparison(tmp_path: Path) -> None:
    result = _run_key_check(
        tmp_path,
        _variables("REQUIRED_KEY", "REQUIRED_EMPTY", "APP_ENV", optional=("SET_KEY",)),
        {
            "SET_KEY": "set",
            "REQUIRED_EMPTY": "empty",
            "EMPTY_OPTIONAL": "empty",
            "OLD_KEY": "set",
            "APP_ENV": "set",
        },
        env_text=f"OLD_KEY={SENTINEL}\n",
        template_text="SET_KEY=\nEMPTY_OPTIONAL=\nUNSET_KEY=\n# COMMENTED_KEY=\n",
        provided="APP_ENV GIT_COMMIT",
        compose_status=1,
    )

    assert result.returncode == 1
    assert "Compose: rejects this env file" in result.stdout
    assert "Missing or empty required keys: REQUIRED_EMPTY REQUIRED_KEY\n" in result.stdout
    assert "Optional template keys not set: EMPTY_OPTIONAL UNSET_KEY\n" in result.stdout
    assert "Keys no Compose file, the template, or another key uses: OLD_KEY\n" in result.stdout
    assert SENTINEL not in result.stdout + result.stderr


def test_key_check_report_exit_status_is_composes_verdict(tmp_path: Path) -> None:
    # ${VAR?} accepts an empty value, so a required key can look empty while
    # Compose accepts the file; the lists explain, Compose decides.
    result = _run_key_check(
        tmp_path, _variables("AUTH_SECRET"), {"AUTH_SECRET": "empty"}, compose_status=0
    )

    assert result.returncode == 0
    assert "Missing or empty required keys: AUTH_SECRET\n" in result.stdout


@pytest.mark.parametrize("action", ["missing", "unknown"])
def test_key_check_hints_never_fail(tmp_path: Path, action: str) -> None:
    result = _run_key_check(
        tmp_path, _variables("REQUIRED_KEY"), {"OLD_KEY": "set"}, action=action, compose_status=1
    )

    assert result.returncode == 0
    assert ("REQUIRED_KEY" if action == "missing" else "OLD_KEY") in result.stderr


@pytest.mark.skipif(shutil.which("just") is None, reason="requires just")
@pytest.mark.parametrize(
    ("alias", "mode", "override_var", "template"),
    [
        ("dev", "development", "BESEDY_WEB_ENV_DEV", ".env.dev.example"),
        ("prod", "production", "BESEDY_WEB_ENV_PROD", ".env.prod.example"),
        ("test", "test", "BESEDY_WEB_ENV_TEST", ".env.test.example"),
        ("development", "development", "BESEDY_WEB_ENV_DEV", ".env.dev.example"),
    ],
)
def test_env_check_recipe_accepts_short_and_long_mode_names(
    tmp_path: Path, alias: str, mode: str, override_var: str, template: str
) -> None:
    env_file = tmp_path / f"{mode}.env"
    env_file.write_text(f"APP_ENV={mode}\n", encoding="utf-8")
    calls = _fake_docker_for_key_checks(
        tmp_path / "bin", _variables(optional=("APP_ENV",)), {"APP_ENV": mode}, rendered={}
    )

    env = os.environ.copy()
    env[override_var] = str(env_file)
    env["PATH"] = f"{tmp_path / 'bin'}{os.pathsep}{env['PATH']}"
    # The Justfile runs recipes in a login shell, whose profile may reset PATH
    # and hide the fake docker; a plain shell keeps it first.
    result = subprocess.run(
        ["just", "--shell", "bash", "--shell-arg", "-c", "env-check", alias],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert f"Template: {REPO_ROOT / 'web' / template}\n" in result.stdout
    assert "Missing or empty required keys: none\n" in result.stdout
    assert calls.exists()


def _compose_available() -> bool:
    if shutil.which("docker") is None:
        return False
    return (
        subprocess.run(
            ["docker", "compose", "version"], capture_output=True, check=False
        ).returncode
        == 0
    )


@pytest.mark.skipif(not _compose_available(), reason="requires docker compose")
@pytest.mark.parametrize(
    ("replace", "extra", "status", "missing", "unset", "unknown"),
    [
        (
            # Values Compose's dotenv parser reads differently from a naive
            # line parser; none of it may produce a false verdict or key.
            ("AUTH_SECRET", "CONFIG_FILE", "UPLOADS_DIR"),
            (
                f"SOURCE={SENTINEL}",
                "AUTH_SECRET=${SOURCE}",
                "CONFIG_FILE: ./besedy.docker.toml",
                'UPLOADS_DIR="" # note',
                f"NOTE='it\\'s {SENTINEL}'",
                'MULTI="first line',
                f"PHANTOM={SENTINEL}",
                'last line"',
            ),
            0,
            "none",
            "UPLOADS_DIR",
            "MULTI NOTE",
        ),
        (("CONFIG_FILE",), ('CONFIG_FILE="" # note',), 1, "CONFIG_FILE", "none", "none"),
    ],
)
def test_env_check_matches_real_compose(
    tmp_path: Path,
    replace: tuple[str, ...],
    extra: tuple[str, ...],
    status: int,
    missing: str,
    unset: str,
    unknown: str,
) -> None:
    template = (REPO_ROOT / "web" / ".env.test.example").read_text(encoding="utf-8")
    kept = [
        line
        for line in template.splitlines()
        if not re.match(rf"\s*({'|'.join(replace)})=", line)
    ]
    env_file = tmp_path / "test.env"
    env_file.write_text("\n".join([*kept, *extra]) + "\n", encoding="utf-8")

    env = os.environ.copy()
    env["BESEDY_WEB_ENV_TEST"] = str(env_file)
    result = subprocess.run(
        ["bash", str(COMPOSE_WRAPPER), "test", "env-check"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == status, result.stdout + result.stderr
    assert f"Missing or empty required keys: {missing}\n" in result.stdout
    assert f"Optional template keys not set: {unset}\n" in result.stdout
    assert f"Keys no Compose file, the template, or another key uses: {unknown}\n" in result.stdout
    assert SENTINEL not in result.stdout + result.stderr
