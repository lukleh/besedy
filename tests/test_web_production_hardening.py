"""Guardrails for production web deployment hardening."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = PROJECT_ROOT / "Justfile"
WEB_COMPOSE = PROJECT_ROOT / "web" / "docker-compose.yml"
WEB_PROD_COMPOSE = PROJECT_ROOT / "web" / "docker-compose.production.yml"


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

    assert "Refusing to build a production web image from a dirty worktree." in justfile
    assert 'docker image tag "${BESEDY_WEB_IMAGE:-besedy-web:prod}"' in justfile
    assert 'docker image tag "${BESEDY_JOBS_IMAGE:-besedy-jobs:prod}"' in justfile
    assert 'image: ${BESEDY_WEB_IMAGE:-besedy-web:prod}' in production_compose
    assert 'CONFIRM_PROD_RESTORE="$backup"' in justfile
    assert 'dropdb --if-exists --force "$PGDATABASE"' in justfile
    assert 'createdb --owner="$PGUSER" "$PGDATABASE"' in justfile
