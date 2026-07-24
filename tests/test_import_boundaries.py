"""Architecture guardrails for the Python package dependency direction."""

from __future__ import annotations

import ast
import importlib.util
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PACKAGE_ROOT = REPO_ROOT / "besedy"

FOUNDATIONAL_MODULES = {
    "besedy.core.paths_common",
    "besedy.core.symlinks",
}


def _module_name(path: Path) -> str:
    parts = list(path.relative_to(REPO_ROOT).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _imports(path: Path, *, source_module: str | None = None) -> Iterator[str]:
    source_module = source_module or _module_name(path)
    source_package = (
        source_module if path.name == "__init__.py" else source_module.rpartition(".")[0]
    )
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield from (alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                if not source_package:
                    continue
                target = importlib.util.resolve_name(
                    f"{'.' * node.level}{node.module or ''}",
                    source_package,
                )
            else:
                target = node.module
            if not target:
                continue
            yield target
            for alias in node.names:
                if alias.name != "*":
                    yield f"{target}.{alias.name}"


def test_relative_imports_are_resolved_to_absolute_modules(tmp_path: Path) -> None:
    module = tmp_path / "consumer.py"
    module.write_text(
        "from . import sibling\nfrom ..commands import runner\n",
        encoding="utf-8",
    )

    assert set(_imports(module, source_module="besedy.lib.consumer")) == {
        "besedy.lib",
        "besedy.lib.sibling",
        "besedy.commands",
        "besedy.commands.runner",
    }


def test_package_layers_do_not_import_entrypoint_layers() -> None:
    """Keep reusable code independent from command and CLI entrypoints."""

    violations: list[str] = []
    for path in sorted(PACKAGE_ROOT.rglob("*.py")):
        source = _module_name(path)
        for target in sorted(set(_imports(path))):
            forbidden = False
            if source.startswith("besedy.lib."):
                forbidden = target.startswith(
                    ("besedy.cli", "besedy.commands", "besedy.workflows")
                )
            elif source.startswith("besedy.workflows."):
                forbidden = target.startswith(("besedy.cli", "besedy.commands"))
            elif source in FOUNDATIONAL_MODULES:
                forbidden = target.startswith(
                    (
                        "besedy.cli",
                        "besedy.commands",
                        "besedy.config",
                        "besedy.lib",
                        "besedy.workflows",
                    )
                )
            if forbidden:
                violations.append(f"{source} -> {target}")

    assert not violations, "Forbidden package-layer imports:\n" + "\n".join(violations)


def test_internal_module_graph_is_acyclic() -> None:
    """Reject direct import cycles, including imports nested inside functions."""

    module_paths = {_module_name(path): path for path in PACKAGE_ROOT.rglob("*.py")}
    graph: dict[str, set[str]] = {module: set() for module in module_paths}
    for source, path in module_paths.items():
        for target in _imports(path):
            if target in module_paths:
                graph[source].add(target)

    visiting: list[str] = []
    visited: set[str] = set()

    def visit(module: str) -> list[str] | None:
        if module in visiting:
            start = visiting.index(module)
            return [*visiting[start:], module]
        if module in visited:
            return None
        visiting.append(module)
        for dependency in sorted(graph[module]):
            cycle = visit(dependency)
            if cycle:
                return cycle
        visiting.pop()
        visited.add(module)
        return None

    for module in sorted(graph):
        cycle = visit(module)
        assert cycle is None, "Import cycle: " + " -> ".join(cycle or [])


def test_importing_path_constants_does_not_load_user_configuration() -> None:
    """Low-level path constants must be importable without a besedy.toml."""

    env = os.environ.copy()
    env["BESEDY_CONFIG"] = str(REPO_ROOT / "does-not-exist.toml")
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; import besedy.core.paths_common; "
                "assert 'besedy.config.settings' not in sys.modules"
            ),
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_catalog_help_does_not_load_user_configuration() -> None:
    """Catalog help must work before the first besedy.toml is created."""

    env = os.environ.copy()
    env["BESEDY_CONFIG"] = str(REPO_ROOT / "does-not-exist.toml")
    for argv in (["--help"], ["run-pipeline", "--help"]):
        result = subprocess.run(
            [sys.executable, "-m", "besedy.cli.catalog", *argv],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        assert "usage:" in result.stdout.lower()
