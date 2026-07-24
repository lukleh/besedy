"""Guardrails for keeping pytest's reported test count meaningful."""

from __future__ import annotations

import ast
from pathlib import Path


def _is_non_executable_statement(statement: ast.stmt) -> bool:
    if isinstance(statement, ast.Pass):
        return True
    return (
        isinstance(statement, ast.Expr)
        and isinstance(statement.value, ast.Constant)
        and (isinstance(statement.value.value, str) or statement.value.value is Ellipsis)
    )


def test_test_functions_have_executable_bodies() -> None:
    """Reject docstring-only, ellipsis-only, and pass-only pytest functions."""
    tests_root = Path(__file__).parent
    placeholders: list[str] = []

    for test_path in sorted(tests_root.rglob("test_*.py")):
        tree = ast.parse(test_path.read_text(encoding="utf-8"), filename=str(test_path))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if not node.name.startswith("test_"):
                continue
            if all(_is_non_executable_statement(statement) for statement in node.body):
                placeholders.append(f"{test_path.relative_to(tests_root)}:{node.lineno}:{node.name}")

    assert not placeholders, "Placeholder tests must be implemented or removed:\n" + "\n".join(
        placeholders
    )
