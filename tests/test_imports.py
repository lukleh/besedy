"""Import smoke tests for the public package and CLI layers."""

from __future__ import annotations

import importlib

import pytest


@pytest.mark.parametrize(
    "module_name",
    [
        "besedy.lib.audio",
        "besedy.lib.catalog",
        "besedy.lib.data",
        "besedy.lib.workflow",
        "besedy.lib.validation",
        "besedy.lib.analysis",
    ],
)
def test_library_packages_import(module_name: str) -> None:
    """Core library packages remain importable without optional extras."""
    assert importlib.import_module(module_name).__name__ == module_name


@pytest.mark.parametrize(
    "module_name",
    [
        "besedy.commands.analyze",
        "besedy.commands.analyze.compare",
        "besedy.commands.analyze.patch_candidates",
        "besedy.commands.analyze.repetition",
        "besedy.commands.analyze.validate",
    ],
)
def test_analyze_command_modules_import(module_name: str) -> None:
    """Analyze command modules remain importable through their current paths."""
    assert importlib.import_module(module_name).__name__ == module_name


@pytest.mark.parametrize(
    "module_name",
    [
        "besedy.commands.catalog",
        "besedy.commands.catalog.check",
        "besedy.commands.catalog.create",
        "besedy.commands.catalog.diarize",
        "besedy.commands.catalog.extract",
        "besedy.commands.catalog.speakers",
        "besedy.commands.catalog.stage",
        "besedy.commands.catalog.transcribe",
    ],
)
def test_catalog_command_modules_import(module_name: str) -> None:
    """Catalog command modules remain importable through their current paths."""
    assert importlib.import_module(module_name).__name__ == module_name


@pytest.mark.parametrize("module_name", ["besedy.cli.catalog", "besedy.cli.analyze"])
def test_cli_dispatch_modules_import(module_name: str) -> None:
    """CLI dispatch modules import their command handlers successfully."""
    assert importlib.import_module(module_name).__name__ == module_name
