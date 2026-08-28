"""Guardrails for production web deployment hardening."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = PROJECT_ROOT / "Justfile"
WEB_COMPOSE = PROJECT_ROOT / "web" / "docker-compose.yml"


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


def test_postgres_18_uses_its_parent_data_volume_in_every_environment() -> None:
    compose = WEB_COMPOSE.read_text(encoding="utf-8")

    assert "image: pgvector/pgvector:pg18" in compose
    assert "image: postgres:18-alpine" in compose
    assert "- postgres_data:/var/lib/postgresql\n" in compose
    assert "/var/lib/postgresql/data" not in compose
    assert "POSTGRES_VERSION" not in compose
