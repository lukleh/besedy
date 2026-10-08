"""Locally built Compose images must never be pulled from a registry."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILES = sorted(
    path
    for path in REPO_ROOT.glob("**/docker-compose*.yml")
    if not {"node_modules", ".venv", ".git"} & set(path.relative_to(REPO_ROOT).parts)
)


def _built_named_services(path: Path) -> list[tuple[str, dict]]:
    services = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}).get("services") or {}
    return [
        (name, service)
        for name, service in services.items()
        if isinstance(service, dict) and "build" in service and "image" in service
    ]


def test_compose_files_found() -> None:
    assert any(_built_named_services(path) for path in COMPOSE_FILES)


@pytest.mark.parametrize("path", COMPOSE_FILES, ids=lambda p: str(p.relative_to(REPO_ROOT)))
def test_built_images_are_never_pulled(path: Path) -> None:
    # With Compose's default pull policy a missing image is first pulled under
    # its tag (e.g. docker.io/besedy/nemo:local) and only built when that fails.
    missing = [
        name
        for name, service in _built_named_services(path)
        if service.get("pull_policy") != "never"
    ]
    assert missing == [], f"{path.relative_to(REPO_ROOT)}: set pull_policy: never on {missing}"
