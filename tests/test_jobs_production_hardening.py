"""Guardrails for the immutable, least-privilege production jobs runtime."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
JOBS_DOCKERFILE = PROJECT_ROOT / "jobs-service" / "Dockerfile"
JOBS_PROD_COMPOSE = PROJECT_ROOT / "jobs-service" / "docker-compose.jobs-prod.yml"
JUSTFILE = PROJECT_ROOT / "Justfile"
WEB_COMPOSE = PROJECT_ROOT / "web" / "docker-compose.yml"


def test_justfile_never_installs_from_an_unchecked_lock() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert "--frozen" not in justfile
    assert justfile.count("uv sync --locked --extra jobs --extra ml") == 2
    # The deploy recipe verifies the target revision's lock before it creates the
    # checkout or stops the worker (behaviour: tests/test_uv_lock_check.py).
    check = justfile.index('bash scripts/check_uv_lock_at_rev.sh "$sha"')
    assert check < justfile.index("git worktree add --detach --lock")
    assert check < justfile.index('systemctl --user stop "$unit"')


def test_jobs_image_uses_locked_non_editable_installs() -> None:
    dockerfile = JOBS_DOCKERFILE.read_text(encoding="utf-8")

    assert "COPY pyproject.toml uv.lock" in dockerfile
    assert dockerfile.count("uv sync") == 2
    assert dockerfile.count("--locked") == 2
    assert "--frozen" not in dockerfile
    assert "--mount=type=ssh" not in dockerfile
    assert "openssh-client" not in dockerfile
    assert "ssh-keyscan" not in dockerfile
    assert "uv pip check --python /opt/venv/bin/python" in dockerfile
    assert "from besedy.lib.prefect_jobs.api import PrefectJobsApiService" in dockerfile
    assert "uv lock" not in dockerfile
    assert "uv build --wheel" not in dockerfile
    assert "ARG REQUIRE_PROVENANCE=false" in dockerfile
    assert 'test "$GIT_COMMIT" != "unknown"' in dockerfile
    assert 'test "$BUILD_TIME" != "unknown"' in dockerfile
    assert "USER besedy:besedy" in dockerfile
    assert "python -m pip install" not in dockerfile


def test_production_jobs_services_are_immutable_and_least_privilege() -> None:
    compose = JOBS_PROD_COMPOSE.read_text(encoding="utf-8")

    assert "..:/workspace/besedy" not in compose
    assert "read_only: true" in compose
    assert "no-new-privileges:true" in compose
    assert "cap_drop:" in compose
    assert "- ALL" in compose
    assert 'user: "${JOBS_CONTAINER_UID:-1000}:${JOBS_CONTAINER_GID:-1000}"' in compose
    assert "/tmp:rw,nosuid,nodev,noexec" in compose
    assert 'REQUIRE_PROVENANCE: "true"' in compose
    assert "additional_contexts" not in compose


def test_jobs_api_requires_no_host_data_or_credentials() -> None:
    import yaml

    compose = yaml.safe_load(JOBS_PROD_COMPOSE.read_text(encoding="utf-8"))
    assert set(compose["services"]) == {"jobs-api"}
    assert not compose["services"]["jobs-api"].get("volumes")


def test_web_database_defaults_to_loopback_binding() -> None:
    compose = WEB_COMPOSE.read_text(encoding="utf-8")

    assert "'${DB_PORT:-127.0.0.1:5433}:5432'" in compose
