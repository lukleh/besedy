"""Static guardrails for the operator-facing Justfile surface."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = PROJECT_ROOT / "Justfile"
WEB_PACKAGE = PROJECT_ROOT / "web" / "package.json"
ARTWORK_MIGRATION = PROJECT_ROOT / "web" / "scripts" / "migrate-artwork-storage.ts"


def test_retired_operator_recipes_are_removed() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    for recipe in (
        "jobs-up",
        "jobs-down",
        "jobs-down-clean",
        "jobs-logs",
        "jobs-rebuild",
        "jobs-status",
        "jobs-db",
        "jobs-deploy",
        "prefect-deploy",
        "embeddings-up",
        "embeddings-down",
        "embeddings-logs",
        "artwork-storage",
    ):
        assert f"\n{recipe}:" not in justfile


def test_shared_colbert_operations_have_a_checkout_guard() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert "_guard-shared-colbert:" in justfile
    assert "besedy-colbert" in justfile
    assert "com.docker.compose.project.working_dir" in justfile
    assert "BESEDY_COLBERT_FORCE" in justfile
    assert "docker compose -f docker-compose.yml up -d --no-build --no-deps colbert" in justfile
    assert "rag-services-up: _colbert-state-dir _guard-shared-colbert" in justfile
    assert "rag-services-down: _guard-shared-colbert" in justfile
    assert "colbert-up: _colbert-state-dir _guard-shared-colbert" in justfile
    assert "colbert-down: _guard-shared-colbert" in justfile


def test_completed_artwork_storage_migration_is_no_longer_exposed() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    package = WEB_PACKAGE.read_text(encoding="utf-8")

    assert "storage:artwork-rename" not in justfile
    assert "storage:artwork-rename" not in package
    assert not ARTWORK_MIGRATION.exists()
