"""Guardrails for the immutable, least-privilege production jobs runtime."""

import tomllib
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
JOBS_DOCKERFILE = PROJECT_ROOT / "jobs-service" / "Dockerfile"
JOBS_PROD_COMPOSE = PROJECT_ROOT / "jobs-service" / "docker-compose.jobs-prod.yml"
JOBS_CODEX_OVERLAY = PROJECT_ROOT / "jobs-service" / "docker-compose.jobs-codex-auth.yml"
CI_WORKFLOW = PROJECT_ROOT / ".github" / "workflows" / "ci.yml"
OPERATIONS_DOC = PROJECT_ROOT / "docs" / "web" / "operations.md"
PYPROJECT = PROJECT_ROOT / "pyproject.toml"
UV_LOCK = PROJECT_ROOT / "uv.lock"
WEB_COMPOSE = PROJECT_ROOT / "web" / "docker-compose.yml"
RLMBENCHY_REVISION = "99ac7864c52f15d298d39fac80dd0c72a2d2ab27"


def test_jobs_image_uses_locked_non_editable_installs() -> None:
    dockerfile = JOBS_DOCKERFILE.read_text(encoding="utf-8")

    assert "COPY pyproject.toml uv.lock" in dockerfile
    assert dockerfile.count("uv sync") == 2
    assert dockerfile.count("--frozen") == 2
    assert "--mount=type=ssh" not in dockerfile
    assert "openssh-client" not in dockerfile
    assert "ssh-keyscan" not in dockerfile
    assert dockerfile.count("apt-get install") == 1
    assert "uv pip check --python /opt/venv/bin/python" in dockerfile
    assert "from rlmbenchy.rlm import load_lm_profile, run_task" in dockerfile
    assert "uv build --wheel" not in dockerfile
    assert "rlmbenchy_source" not in dockerfile
    assert "DSPY_CACHEDIR=/tmp/cache/dspy" in dockerfile
    assert "ARG REQUIRE_PROVENANCE=false" in dockerfile
    assert 'test "$GIT_COMMIT" != "unknown"' in dockerfile
    assert 'test "$BUILD_TIME" != "unknown"' in dockerfile
    assert "USER besedy:besedy" in dockerfile
    assert "python -m pip install" not in dockerfile


def test_jobs_extra_pins_rlmbenchy_to_an_exact_git_revision() -> None:
    pyproject = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))

    assert (
        "rlmbenchy @ "
        f"git+https://github.com/lukleh/rlmbenchy.git@{RLMBENCHY_REVISION}"
        in pyproject["project"]["optional-dependencies"]["jobs"]
    )
    assert "rlmbenchy" not in pyproject["tool"]["uv"]["sources"]
    assert RLMBENCHY_REVISION in UV_LOCK.read_text(encoding="utf-8")


def test_diskcache_audit_exception_is_scoped_and_documented() -> None:
    workflow = CI_WORKFLOW.read_text(encoding="utf-8")
    operations = OPERATIONS_DOC.read_text(encoding="utf-8")

    assert workflow.count("--ignore-vuln PYSEC-2026-2447") == 1
    assert "PYSEC-2026-2447" in operations
    assert "worker-owned cache" in operations
    assert "ephemeral, non-root `/tmp` filesystem" in operations


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
    assert "RLMBENCHY_GIT_SSH_KEY" not in compose
    assert "additional_contexts" not in compose
    assert "RLMBENCHY_SOURCE_REVISION" not in compose


def test_production_jobs_mounts_only_codex_auth_file() -> None:
    compose = JOBS_PROD_COMPOSE.read_text(encoding="utf-8")
    overlay = JOBS_CODEX_OVERLAY.read_text(encoding="utf-8")

    assert "CODEX_HOST_AUTH_DIR" not in compose
    assert "CODEX_HOST_AUTH_FILE" not in compose
    assert "source: ${CODEX_HOST_AUTH_FILE:?" in overlay
    assert "target: ${CODEX_CONTAINER_HOME:-/run/codex}/auth.json" in overlay
    assert "read_only: true" in overlay
    assert "create_host_path: false" in overlay


def test_web_database_defaults_to_loopback_binding() -> None:
    compose = WEB_COMPOSE.read_text(encoding="utf-8")

    assert "'${DB_PORT:-127.0.0.1:5433}:5432'" in compose
