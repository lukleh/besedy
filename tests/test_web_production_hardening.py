"""Guardrails for production web deployment hardening."""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = PROJECT_ROOT / "Justfile"
WEB_COMPOSE = PROJECT_ROOT / "web" / "docker-compose.yml"
WEB_PROD_COMPOSE = PROJECT_ROOT / "web" / "docker-compose.production.yml"
WEB_COMPOSE_WRAPPER = PROJECT_ROOT / "scripts" / "run_web_compose.sh"
WEB_DOCKERFILE = PROJECT_ROOT / "web" / "Dockerfile"
WEB_DB_INIT_SCRIPT = PROJECT_ROOT / "web" / "init-db-users.sh"
WEB_MIGRATIONS = PROJECT_ROOT / "web" / "prisma" / "migrations"
# Extensions PostgreSQL marks trusted, which the non-superuser migrator may create.
TRUSTED_POSTGRES_EXTENSIONS = {"pgcrypto"}
CREATE_EXTENSION = re.compile(r"CREATE EXTENSION (?:IF NOT EXISTS )?\"?(\w+)", re.IGNORECASE)


def test_prod_migrate_restores_audit_log_delete_revoke_after_blanket_grant() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    grant = "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public"
    revoke = "REVOKE DELETE ON TABLE public.audit_log FROM besedy_app"

    assert grant in justfile
    assert revoke in justfile
    assert justfile.index(grant) < justfile.index(revoke)


def test_production_recipes_do_not_require_removed_scanner_secret() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert "SCAN_SECRET" not in justfile


def test_web_only_production_deploys_do_not_start_or_recreate_dependencies() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert "{{ prod_compose }} up -d --no-deps web" in justfile
    assert "{{ prod_compose }} up -d --no-deps --no-build --remove-orphans web" in justfile
    assert "{{ prod_compose }} up -d --no-recreate --remove-orphans" in justfile


def test_postgres_18_uses_its_parent_data_volume_in_every_environment() -> None:
    compose = WEB_COMPOSE.read_text(encoding="utf-8")

    assert "image: pgvector/pgvector:pg18" in compose
    assert "image: postgres:18-alpine" in compose
    assert "- postgres_data:/var/lib/postgresql\n" in compose
    assert "/var/lib/postgresql/data" not in compose
    assert "POSTGRES_VERSION" not in compose


def _sql_extensions(text: str) -> set[str]:
    code = "\n".join(line.split("--", 1)[0] for line in text.splitlines())
    return {name.lower() for name in CREATE_EXTENSION.findall(code)}


def test_fresh_database_init_creates_extensions_the_migrator_cannot() -> None:
    migration_extensions: set[str] = set()
    for migration in sorted(WEB_MIGRATIONS.glob("*/migration.sql")):
        migration_extensions |= _sql_extensions(migration.read_text(encoding="utf-8"))
    init_extensions = _sql_extensions(WEB_DB_INIT_SCRIPT.read_text(encoding="utf-8"))

    assert "vector" in migration_extensions
    assert migration_extensions - TRUSTED_POSTGRES_EXTENSIONS <= init_extensions


def test_manual_backup_uses_container_shell_variables_and_retained_directory() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    backup_recipe = justfile.split("prod-backup:", maxsplit=1)[1].split(
        "\n# Restore one retained", maxsplit=1
    )[0]

    assert "$$" not in backup_recipe
    assert 'FILENAME="/backups/deploy/besedy_deploy_${commit}_' in backup_recipe
    assert 'gzip -t "$ARCHIVE"' in backup_recipe


def test_production_builds_and_restore_keep_exact_rollback_artifacts() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    production_compose = WEB_PROD_COMPOSE.read_text(encoding="utf-8")
    compose_wrapper = WEB_COMPOSE_WRAPPER.read_text(encoding="utf-8")
    dockerfile = WEB_DOCKERFILE.read_text(encoding="utf-8")

    assert "Refusing to build a production web image from a dirty worktree." in justfile
    assert 'docker image tag "${BESEDY_WEB_IMAGE:-besedy-web:prod}"' in justfile
    assert 'docker image tag "${BESEDY_JOBS_IMAGE:-besedy-jobs:prod}"' in justfile
    assert 'docker image tag "$jobs_image" "besedy-jobs:$GIT_COMMIT"' in justfile
    assert "skipping its rollback snapshot" in justfile
    assert "LABEL org.opencontainers.image.revision=${GIT_COMMIT}" in dockerfile
    assert 'image: ${BESEDY_WEB_IMAGE:-besedy-web:prod}' in production_compose
    assert "GIT_COMMIT WEB_VERSION BUILD_TIME BESEDY_WEB_IMAGE" in compose_wrapper
    assert 'CONFIRM_PROD_RESTORE="$backup"' in justfile
    assert 'dropdb --if-exists --force "$PGDATABASE"' in justfile
    assert 'createdb --owner="$PGUSER" "$PGDATABASE"' in justfile


def test_prod_apply_refuses_an_image_from_a_different_checkout_before_downtime() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    apply_recipe = justfile.split("prod-apply:", maxsplit=1)[1].split(
        "\n# Full production web deployment", maxsplit=1
    )[0]

    label = 'org.opencontainers.image.revision'
    assert label in apply_recipe
    assert 'resolve_web_env_file.sh production' in apply_recipe
    assert 'if [ "$image_commit" != "$git_commit" ]' in apply_recipe
    assert "Run just prod-build from this checkout before applying it." in apply_recipe
    assert apply_recipe.index(label) < apply_recipe.index("stop web backup")


def test_prod_build_reads_jobs_image_without_polluting_web_validation() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    build_recipe = justfile.split("\nprod-build:", maxsplit=1)[1].split(
        "\n# Stop the web writer", maxsplit=1
    )[0]
    assert "resolve_jobs_env_file.sh production" in build_recipe
    assert "Missing production jobs env file" in build_recipe
    assert build_recipe.count('. "$jobs_env"') == 1
    assert build_recipe.index('jobs_image="$(') < build_recipe.index("cd web")
    assert build_recipe.index("require_env DATABASE_URL") < build_recipe.index(
        'docker image inspect "$jobs_image"'
    )


def test_fresh_host_can_build_web_before_the_coordinated_jobs_build() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    build_recipe = justfile.split("\nprod-build:", maxsplit=1)[1].split(
        "\n# Stop the web writer", maxsplit=1
    )[0]
    coordinated_recipe = justfile.split("prod-deploy-with-jobs:", maxsplit=1)[
        1
    ].split("\n# The same coordinated", maxsplit=1)[0]

    assert 'if docker image inspect "$jobs_image"' in build_recipe
    assert "exit 1" not in build_recipe.split(
        'if docker image inspect "$jobs_image"', maxsplit=1
    )[1]
    assert coordinated_recipe.index("just prod-build") < coordinated_recipe.index(
        "just jobs-prod-build"
    )
    assert coordinated_recipe.index("just jobs-prod-build") < coordinated_recipe.index(
        "just _prod-apply-with-jobs"
    )


def test_first_deploy_starts_the_database_before_the_pre_migration_backup() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    # Slice at the next recipe header rather than at a comment that may be reworded.
    apply_recipe = justfile.split("\nprod-apply:", maxsplit=1)[1].split(
        "\nprod-deploy:", maxsplit=1
    )[0]
    start_db = "{{ prod_compose }} up -d --no-deps --no-recreate --wait db"

    assert start_db in apply_recipe
    assert apply_recipe.index(start_db) < apply_recipe.index("just prod-backup")


def _run_jobs_secret_check(tmp_path: Path, secret_line: str) -> subprocess.CompletedProcess[str]:
    jobs_env = tmp_path / "jobs.env.dev"
    jobs_env.write_text(f"JOBS_SERVICE_PORT=8390\n{secret_line}\n", encoding="utf-8")
    env = os.environ.copy()
    env["BESEDY_JOBS_ENV_DEV"] = str(jobs_env)
    return subprocess.run(
        ["just", "_jobs-secret-check", "development"],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.skipif(shutil.which("just") is None, reason="requires just")
def test_jobs_runtime_refuses_to_start_with_an_empty_service_secret(tmp_path: Path) -> None:
    result = _run_jobs_secret_check(tmp_path, "BESEDY_JOB_SERVICE_SECRET=")

    assert result.returncode == 1
    assert "BESEDY_JOB_SERVICE_SECRET is empty" in result.stderr
    assert str(tmp_path / "jobs.env.dev") in result.stderr


@pytest.mark.skipif(shutil.which("just") is None, reason="requires just")
def test_jobs_runtime_starts_with_a_configured_service_secret(tmp_path: Path) -> None:
    result = _run_jobs_secret_check(
        tmp_path, "BESEDY_JOB_SERVICE_SECRET=dev-jobs-service-secret-12345"
    )

    assert result.returncode == 0, result.stderr


def test_every_jobs_runtime_start_checks_the_service_secret_first() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    expected = {
        "jobs-dev-up": "development",
        "jobs-test-up": "test",
        "jobs-prod-up": "production",
        "jobs-prod-up-codex": "production",
    }

    for recipe, mode in expected.items():
        assert f'\n{recipe}: (_jobs-secret-check "{mode}")\n' in justfile, recipe


JOBS_SERVICE = PROJECT_ROOT / "jobs-service"
JOBS_ENV_RESOLVER = PROJECT_ROOT / "scripts" / "resolve_jobs_env_file.sh"
# Template suffix -> resolver mode, for the three jobs runtimes.
JOBS_RUNTIMES = {"dev": "development", "test": "test", "prod": "production"}
COMPOSE_DEFAULT = re.compile(r"\$\{([A-Z_]+):-([^}$]*)\}")


def _env_assignments(path: Path) -> dict[str, str]:
    return dict(
        line.split("=", 1)
        for line in path.read_text(encoding="utf-8").splitlines()
        if "=" in line and not line.lstrip().startswith("#")
    )


def _compose_defaults(path: Path) -> dict[str, str]:
    defaults: dict[str, str] = {}
    for name, value in COMPOSE_DEFAULT.findall(path.read_text(encoding="utf-8")):
        defaults.setdefault(name, value)
    return defaults


@pytest.mark.parametrize("env", sorted(JOBS_RUNTIMES))
def test_each_jobs_runtime_template_matches_its_compose_defaults(env: str) -> None:
    template = _env_assignments(JOBS_SERVICE / f".env.{env}.example")
    compose = _compose_defaults(JOBS_SERVICE / f"docker-compose.jobs-{env}.yml")

    # A template copied verbatim must select the runtime it is named after.
    for name in (
        "PREFECT_DEEP_SEARCH_WORK_POOL",
        "PREFECT_DEEP_SEARCH_DEPLOYMENT_NAME",
        "PREFECT_DEEP_SEARCH_FULL_DEPLOYMENT_NAME",
        "BESEDY_INTERNAL_BASE_URL",
        "DEEP_SEARCH_OUTPUT_ENV",
        "JOBS_SERVICE_HOST_PORT",
    ):
        assert template[name] == compose[name], name
    assert template["DEEP_SEARCH_OUTPUT_DIR"] == f"/state/lukleh/besedy/deep-search/{env}"
    # Output ownership stays a per-host choice, so no template assigns it.
    assert template.keys().isdisjoint({"BESEDY_OUTPUT_CHOWN_UID", "BESEDY_OUTPUT_CHOWN_GID"})


def test_jobs_runtime_templates_carry_the_secret_of_their_web_template() -> None:
    web = PROJECT_ROOT / "web"
    for env in ("dev", "test"):
        jobs_secret = _env_assignments(JOBS_SERVICE / f".env.{env}.example")[
            "BESEDY_JOB_SERVICE_SECRET"
        ]
        web_secret = _env_assignments(web / f".env.{env}.example")["BESEDY_JOB_SERVICE_SECRET"]
        assert jobs_secret and jobs_secret == web_secret, env
    # Production never ships a secret; the operator generates one.
    assert _env_assignments(JOBS_SERVICE / ".env.prod.example")["BESEDY_JOB_SERVICE_SECRET"] == ""


def test_prefect_template_configures_only_the_control_plane() -> None:
    template = _env_assignments(JOBS_SERVICE / ".env.prefect.example")
    compose_vars = set(
        re.findall(r"\$\{([A-Z_]+)", (JOBS_SERVICE / "docker-compose.prefect.yml").read_text())
    )

    assert "PREFECT_IMAGE" in template
    assert template.keys() <= compose_vars
    assert "BESEDY_JOB_SERVICE_SECRET" not in template


@pytest.mark.parametrize(
    ("mode", "example"),
    [
        ("prefect", ".env.prefect.example"),
        ("development", ".env.dev.example"),
        ("test", ".env.test.example"),
        ("production", ".env.prod.example"),
    ],
)
def test_jobs_env_resolver_names_the_matching_template(
    tmp_path: Path, mode: str, example: str
) -> None:
    env = {
        name: value for name, value in os.environ.items() if not name.startswith("BESEDY_JOBS_ENV_")
    }
    env["HOME"] = str(tmp_path)
    env["XDG_CONFIG_HOME"] = str(tmp_path / ".config")
    result = subprocess.run(
        ["bash", str(JOBS_ENV_RESOLVER), mode],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert str(JOBS_SERVICE / example) in result.stderr
    assert (JOBS_SERVICE / example).is_file()


def test_database_healthcheck_waits_for_the_tcp_listener() -> None:
    compose = WEB_COMPOSE.read_text(encoding="utf-8")

    assert "pg_isready -h 127.0.0.1 -U ${POSTGRES_USER:-besedy}" in compose


def test_database_maintenance_quiesces_scheduled_backups() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    restore_recipe = justfile.split("prod-restore *args:", maxsplit=1)[1].split(
        "\n# Restore a retained database backup", maxsplit=1
    )[0]

    assert "{{ prod_compose }} stop web backup" in justfile
    assert "ps --services --status running backup" in restore_recipe
    assert "scheduled backup service before restoring" in restore_recipe


def test_rollback_preserves_optional_codex_auth_overlay() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert "prod-rollback-codex commit backup:" in justfile
    assert 'just _prod-rollback jobs-prod-start-codex "$1" "$2"' in justfile
    assert 'BESEDY_JOBS_IMAGE="besedy-jobs:$commit" just "$jobs_start"' in justfile
