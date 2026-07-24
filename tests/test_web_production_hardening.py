"""Guardrails for production web deployment hardening."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = PROJECT_ROOT / "Justfile"


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
