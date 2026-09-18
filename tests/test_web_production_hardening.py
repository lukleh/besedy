"""Guardrails for production web deployment hardening."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = PROJECT_ROOT / "Justfile"
WEB_COMPOSE = PROJECT_ROOT / "web" / "docker-compose.yml"
WEB_PROD_COMPOSE = PROJECT_ROOT / "web" / "docker-compose.production.yml"
WEB_COMPOSE_WRAPPER = PROJECT_ROOT / "scripts" / "run_web_compose.sh"
WEB_DOCKERFILE = PROJECT_ROOT / "web" / "Dockerfile"


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
    build_recipe = justfile.split("prod-build:", maxsplit=1)[1].split(
        "\n# Stop the web writer", maxsplit=1
    )[0]
    assert "resolve_jobs_env_file.sh production" in build_recipe
    assert build_recipe.index("resolve_jobs_env_file.sh production") < build_recipe.index(
        'jobs_image="${BESEDY_JOBS_IMAGE:-besedy-jobs:prod}"'
    )


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
