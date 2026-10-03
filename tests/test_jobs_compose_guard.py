"""The jobs Compose wrapper refuses a project that points at another environment."""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
WRAPPER = REPO_ROOT / "scripts" / "run_jobs_compose.sh"
VALIDATOR = REPO_ROOT / "scripts" / "validate_jobs_compose_config.sh"

SUFFIX = {"development": "dev", "test": "test", "production": "prod"}


def rendered(mode: str) -> dict[str, object]:
    """A correctly wired rendered jobs project, as `docker compose config` prints it."""
    suffix = SUFFIX[mode]
    pool = f"besedy-deep-search-{suffix}"
    output_dir = f"/state/lukleh/besedy/deep-search/{suffix}"
    return {
        "name": f"besedy-jobs-{suffix}",
        "services": {
            "jobs-api": {
                "container_name": f"besedy-{suffix}-jobs-api",
                "environment": {
                    "PREFECT_DEEP_SEARCH_WORK_POOL": pool,
                    "PREFECT_INGEST_WORK_POOL": f"besedy-ingest-{suffix}",
                    "DEEP_SEARCH_OUTPUT_ENV": suffix,
                    "DEEP_SEARCH_OUTPUT_DIR": output_dir,
                    "PREFECT_DEEP_SEARCH_DEPLOYMENT_NAME": f"deep-search-{suffix}",
                    "PREFECT_DEEP_SEARCH_FULL_DEPLOYMENT_NAME": f"deep_search_flow/deep-search-{suffix}",
                    "PREFECT_INGEST_DEPLOYMENT_NAME": f"ingest-{suffix}",
                    "PREFECT_INGEST_FULL_DEPLOYMENT_NAME": f"ingest_recording_flow/ingest-{suffix}",
                    "PREFECT_INGEST_REMOVE_DEPLOYMENT_NAME": f"ingest-remove-{suffix}",
                    "PREFECT_INGEST_REMOVE_FULL_DEPLOYMENT_NAME": f"remove_recording_flow/ingest-remove-{suffix}",
                    "PREFECT_CORRECTION_INDEX_DEPLOYMENT_NAME": f"correction-index-{suffix}",
                    "PREFECT_CORRECTION_INDEX_FULL_DEPLOYMENT_NAME": f"sync_correction_index_flow/correction-index-{suffix}",
                },
            },
            "prefect-worker": {
                "container_name": f"besedy-{suffix}-prefect-worker",
                "command": ["prefect", "worker", "start", "--pool", pool, "--type", "process"],
                "environment": {
                    "PREFECT_DEEP_SEARCH_WORK_POOL": pool,
                    "DEEP_SEARCH_OUTPUT_ENV": suffix,
                    "DEEP_SEARCH_OUTPUT_DIR": output_dir,
                    "BESEDY_INTERNAL_BASE_URL": f"http://besedy-{mode}-web:3000",
                },
            },
        },
    }


def validate(config: dict[str, object], mode: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(VALIDATOR), mode, "/env/jobs.env"],
        input=json.dumps(config),
        capture_output=True,
        text=True,
        check=False,
    )


def mutated(mode: str, service: str, path: str, value: object) -> dict[str, object]:
    config = copy.deepcopy(rendered(mode))
    target = config["services"][service]  # type: ignore[index]
    keys = path.split(".")
    for key in keys[:-1]:
        target = target[key]
    target[keys[-1]] = value
    return config


@pytest.mark.parametrize("mode", ["development", "test", "production"])
def test_validator_accepts_a_correctly_wired_project(mode: str) -> None:
    result = validate(rendered(mode), mode)

    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    ("mode", "service", "path", "value", "message"),
    [
        # #192: the development values copied into the production env file.
        (
            "production",
            "prefect-worker",
            "environment.BESEDY_INTERNAL_BASE_URL",
            "http://besedy-development-web:3000",
            "BESEDY_INTERNAL_BASE_URL is 'http://besedy-development-web:3000', "
            "expected http://besedy-production-web:3000",
        ),
        (
            "development",
            "prefect-worker",
            "environment.BESEDY_INTERNAL_BASE_URL",
            "http://besedy-production-web:3000",
            "expected http://besedy-development-web:3000",
        ),
        (
            "test",
            "prefect-worker",
            "environment.BESEDY_INTERNAL_BASE_URL",
            "http://web:3000",
            "expected http://besedy-test-web:3000",
        ),
        (
            "production",
            "jobs-api",
            "environment.PREFECT_DEEP_SEARCH_WORK_POOL",
            "besedy-deep-search",
            "jobs-api PREFECT_DEEP_SEARCH_WORK_POOL is 'besedy-deep-search', "
            "expected a name ending in '-prod'",
        ),
        (
            "production",
            "jobs-api",
            "environment.PREFECT_INGEST_WORK_POOL",
            "besedy-ingest-dev",
            "PREFECT_INGEST_WORK_POOL is 'besedy-ingest-dev'",
        ),
        (
            "production",
            "prefect-worker",
            "command",
            ["prefect", "worker", "start", "--pool", "besedy-deep-search-dev"],
            "prefect-worker pool is 'besedy-deep-search-dev'",
        ),
        (
            "production",
            "jobs-api",
            "environment.PREFECT_INGEST_FULL_DEPLOYMENT_NAME",
            "ingest_recording_flow/ingest-dev",
            "PREFECT_INGEST_FULL_DEPLOYMENT_NAME is 'ingest_recording_flow/ingest-dev'",
        ),
        (
            "production",
            "jobs-api",
            "environment.DEEP_SEARCH_OUTPUT_ENV",
            "dev",
            "DEEP_SEARCH_OUTPUT_ENV is 'dev', expected 'prod'",
        ),
        (
            "production",
            "prefect-worker",
            "environment.DEEP_SEARCH_OUTPUT_DIR",
            "/state/lukleh/besedy/deep-search/dev",
            "DEEP_SEARCH_OUTPUT_DIR is '/state/lukleh/besedy/deep-search/dev'",
        ),
        (
            "test",
            "jobs-api",
            "container_name",
            "besedy-dev-jobs-api",
            "container name is 'besedy-dev-jobs-api', expected the prefix 'besedy-test-'",
        ),
    ],
)
def test_validator_refuses_values_of_another_environment(
    mode: str, service: str, path: str, value: object, message: str
) -> None:
    result = validate(mutated(mode, service, path, value), mode)

    assert result.returncode == 1
    assert message in result.stderr
    # Each failure names the env file to fix.
    assert "/env/jobs.env" in result.stderr


def test_validator_reads_the_pool_from_the_equals_form_too() -> None:
    config = mutated(
        "production", "prefect-worker", "command", ["prefect", "worker", "start", "--pool=besedy-deep-search-prod"]
    )
    assert validate(config, "production").returncode == 0

    config = mutated(
        "production", "prefect-worker", "command", ["prefect", "worker", "start", "--pool=besedy-deep-search-dev"]
    )
    result = validate(config, "production")
    assert result.returncode == 1
    assert "prefect-worker pool is 'besedy-deep-search-dev'" in result.stderr


def test_validator_refuses_a_project_of_another_environment() -> None:
    config = rendered("production")
    config["name"] = "besedy-jobs-dev"

    result = validate(config, "production")

    assert result.returncode == 1
    assert "project is 'besedy-jobs-dev', expected 'besedy-jobs-prod'" in result.stderr


def test_validator_refuses_a_missing_worker_url() -> None:
    config = rendered("production")
    del config["services"]["prefect-worker"]["environment"]["BESEDY_INTERNAL_BASE_URL"]  # type: ignore[index]

    result = validate(config, "production")

    assert result.returncode == 1
    assert "BESEDY_INTERNAL_BASE_URL is not set" in result.stderr


def _fake_docker(bin_dir: Path, config: dict[str, object] | None) -> Path:
    """A docker that prints `config` for `config --format json` and logs every call."""
    bin_dir.mkdir()
    calls = bin_dir / "calls.log"
    rendered_file = bin_dir / "rendered.json"
    if config is not None:
        rendered_file.write_text(json.dumps(config), encoding="utf-8")
    docker = bin_dir / "docker"
    docker.write_text(
        f"""#!/usr/bin/env bash
printf '%s\\n' "$*" >> {calls}
if [[ " $* " == *" config --format json "* ]]; then
  [[ -f {rendered_file} ]] || {{ echo "env var required but not set" >&2; exit 1; }}
  cat {rendered_file}
fi
""",
        encoding="utf-8",
    )
    docker.chmod(0o755)
    return calls


def _env_file(tmp_path: Path, mode: str) -> dict[str, str]:
    env_file = tmp_path / f"jobs.env.{mode}"
    env_file.write_text("# test env file\n", encoding="utf-8")
    env = os.environ.copy()
    for name in ("BESEDY_JOBS_ENV_DEV", "BESEDY_JOBS_ENV_TEST", "BESEDY_JOBS_ENV_PROD"):
        env.pop(name, None)
    env[f"BESEDY_JOBS_ENV_{SUFFIX.get(mode, mode).upper()}"] = str(env_file)
    env["PATH"] = f"{tmp_path / 'bin'}:{env['PATH']}"
    return env


def run_wrapper(
    tmp_path: Path, mode: str, config: dict[str, object] | None, *args: str
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    calls = _fake_docker(tmp_path / "bin", config)
    result = subprocess.run(
        ["bash", str(WRAPPER), mode, *args],
        cwd=REPO_ROOT,
        env=_env_file(tmp_path, mode),
        capture_output=True,
        text=True,
        check=False,
    )
    return result, calls.read_text(encoding="utf-8").splitlines() if calls.exists() else []


@pytest.mark.parametrize("mode", ["development", "test", "production"])
def test_wrapper_runs_the_command_with_this_modes_files_after_validating(
    tmp_path: Path, mode: str
) -> None:
    result, calls = run_wrapper(tmp_path, mode, rendered(mode), "up", "-d", "--no-build")

    assert result.returncode == 0, result.stderr
    assert len(calls) == 2
    env_file = tmp_path / f"jobs.env.{mode}"
    compose_file = f"jobs-service/docker-compose.jobs-{SUFFIX[mode]}.yml"
    assert calls[0] == f"compose --env-file {env_file} -f {compose_file} config --format json"
    assert calls[1] == f"compose --env-file {env_file} -f {compose_file} up -d --no-build"


def test_wrapper_refuses_before_running_any_command_when_a_value_names_another_environment(
    tmp_path: Path,
) -> None:
    config = mutated(
        "production",
        "prefect-worker",
        "environment.BESEDY_INTERNAL_BASE_URL",
        "http://besedy-development-web:3000",
    )

    result, calls = run_wrapper(tmp_path, "production", config, "up", "-d")

    assert result.returncode == 1
    assert "http://besedy-development-web:3000" in result.stderr
    assert str(tmp_path / "jobs.env.production") in result.stderr
    # Only the render ran; `up` never did.
    assert len(calls) == 1
    assert calls[0].endswith("config --format json")


@pytest.mark.parametrize("command", [["down"], ["stop", "jobs-api"], ["logs", "-f"], ["ps"], ["build", "jobs-api"]])
def test_wrapper_runs_stopping_and_inspecting_commands_even_for_a_mis_wired_project(
    tmp_path: Path, command: list[str]
) -> None:
    config = mutated(
        "production",
        "prefect-worker",
        "environment.BESEDY_INTERNAL_BASE_URL",
        "http://besedy-development-web:3000",
    )

    result, calls = run_wrapper(tmp_path, "production", config, *command)

    assert result.returncode == 0, result.stderr
    # No render and no validation: a wrong stack has to stay stoppable.
    assert len(calls) == 1
    assert calls[0].endswith(" ".join(command))


@pytest.mark.parametrize("command", ["up", "create", "run", "start", "restart", "scale"])
def test_wrapper_validates_every_command_that_creates_or_starts_containers(
    tmp_path: Path, command: str
) -> None:
    config = mutated(
        "production", "jobs-api", "environment.DEEP_SEARCH_OUTPUT_ENV", "dev"
    )

    result, calls = run_wrapper(tmp_path, "production", config, command, "jobs-api")

    assert result.returncode == 1
    assert len(calls) == 1


def test_wrapper_reports_a_render_failure_with_the_env_file(tmp_path: Path) -> None:
    result, calls = run_wrapper(tmp_path, "production", None, "up")

    assert result.returncode == 1
    assert "env var required but not set" in result.stderr
    assert str(tmp_path / "jobs.env.production") in result.stderr
    assert len(calls) == 1


def test_wrapper_adds_the_codex_overlay_for_production_only(tmp_path: Path) -> None:
    result, calls = run_wrapper(tmp_path, "production", rendered("production"), "--codex-auth", "up")

    assert result.returncode == 0, result.stderr
    assert all(
        "-f jobs-service/docker-compose.jobs-prod.yml -f "
        "jobs-service/docker-compose.jobs-codex-auth.yml" in call
        for call in calls
    )

    result, _ = run_wrapper(tmp_path / "dev", "development", rendered("development"), "--codex-auth", "up")
    assert result.returncode == 1
    assert "--codex-auth is only valid for production" in result.stderr


@pytest.mark.parametrize(
    "option",
    ["-f", "--file=x.yml", "--env-file", "-p", "--project-name=x", "--project-directory", "-ffoo"],
)
def test_wrapper_refuses_options_that_change_the_project_or_files(
    tmp_path: Path, option: str
) -> None:
    result, calls = run_wrapper(tmp_path, "production", rendered("production"), option, "ps")

    assert result.returncode == 1
    assert "controlled by this wrapper" in result.stderr
    assert calls == []


def test_wrapper_requires_a_known_mode_and_a_command(tmp_path: Path) -> None:
    unknown, _ = run_wrapper(tmp_path, "staging", None, "ps")
    assert unknown.returncode == 1
    assert "Unsupported mode: staging" in unknown.stderr

    missing, calls = run_wrapper(tmp_path / "again", "test", rendered("test"))
    assert missing.returncode == 1
    assert "A Docker Compose command is required" in missing.stderr
    assert calls == []


def test_the_wrapper_and_validator_are_executable_in_git() -> None:
    # core.fileMode=false hides a missing executable bit locally, and every
    # recipe then fails with "Permission denied" on a fresh checkout.
    in_git = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if in_git.returncode != 0:
        pytest.skip("not a git checkout")
    listed = subprocess.run(
        ["git", "ls-files", "-s", "--", "scripts/run_jobs_compose.sh", "scripts/validate_jobs_compose_config.sh"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    modes = {line.split("\t")[1]: line.split()[0] for line in listed}
    if not modes:
        pytest.skip("the scripts are not tracked by git here")

    assert modes == {
        "scripts/run_jobs_compose.sh": "100755",
        "scripts/validate_jobs_compose_config.sh": "100755",
    }


def _clean_env() -> dict[str, str]:
    """The environment without values that would change what Compose renders."""
    return {
        name: value
        for name, value in os.environ.items()
        if not name.startswith(("COMPOSE_", "PREFECT_", "DEEP_SEARCH_", "BESEDY_"))
    }


def _real_compose_available() -> bool:
    if shutil.which("docker") is None:
        return False
    return (
        subprocess.run(
            ["docker", "compose", "version"], capture_output=True, check=False
        ).returncode
        == 0
    )


@pytest.mark.skipif(not _real_compose_available(), reason="docker compose is not installed")
@pytest.mark.parametrize("mode", ["development", "test", "production"])
def test_the_checked_in_compose_files_render_a_project_the_validator_accepts(
    tmp_path: Path, mode: str
) -> None:
    env_file = tmp_path / "jobs.env"
    env_file.write_text("", encoding="utf-8")
    rendered_config = subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            str(env_file),
            "-f",
            f"jobs-service/docker-compose.jobs-{SUFFIX[mode]}.yml",
            "config",
            "--format",
            "json",
        ],
        cwd=REPO_ROOT,
        env=_clean_env(),
        capture_output=True,
        text=True,
        check=True,
    ).stdout

    result = validate(json.loads(rendered_config), mode)

    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(not _real_compose_available(), reason="docker compose is not installed")
def test_a_production_env_file_naming_the_development_web_is_refused(tmp_path: Path) -> None:
    env_file = tmp_path / "jobs.env.prod"
    env_file.write_text(
        "BESEDY_INTERNAL_BASE_URL=http://besedy-development-web:3000\n"
        "PREFECT_DEEP_SEARCH_WORK_POOL=besedy-deep-search\n"
        "DEEP_SEARCH_OUTPUT_ENV=dev\n",
        encoding="utf-8",
    )
    # Real `docker compose config`, but nothing else reaches Docker: a wrapper
    # that wrongly let `up` through must not start containers on this host.
    real_docker = shutil.which("docker")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = bin_dir / "calls.log"
    shim = bin_dir / "docker"
    shim.write_text(
        f"""#!/usr/bin/env bash
if [[ " $* " == *" config "* ]]; then exec {real_docker} "$@"; fi
printf '%s\\n' "$*" >> {calls}
""",
        encoding="utf-8",
    )
    shim.chmod(0o755)
    env = _clean_env()
    env["BESEDY_JOBS_ENV_PROD"] = str(env_file)
    env["PATH"] = f"{bin_dir}:{env['PATH']}"

    result = subprocess.run(
        ["bash", str(WRAPPER), "production", "up", "-d"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert "Unsafe jobs Compose configuration for production" in result.stderr
    assert str(env_file) in result.stderr
    assert not calls.exists()
