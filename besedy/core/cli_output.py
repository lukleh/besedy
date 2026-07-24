"""Helpers for consistent machine-readable CLI output.

The main convention for JSON output across Besedy CLIs is a single top-level object:

    {
      "name": "<command>",
      "status": "success" | "warning" | "error",
      "result": { ... }
    }

This keeps stdout parseable (one JSON object) while letting each command define
its own `result` payload.
"""

from __future__ import annotations

import json
from typing import Any, Literal

JsonStatus = Literal["success", "warning", "error"]


def build_json_envelope(
    *,
    name: str,
    status: JsonStatus,
    result: Any,
    output: str | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the standard JSON envelope for CLI output."""
    payload: dict[str, Any] = {
        "name": name,
        "status": status,
        "result": result,
    }
    if output:
        payload["output"] = output
    if meta:
        payload["meta"] = meta
    return payload


def print_json_envelope(payload: dict[str, Any]) -> None:
    """Print a JSON envelope to stdout."""
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def print_json_result(
    *,
    name: str,
    status: JsonStatus,
    result: Any,
    output: str | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    """Convenience wrapper: build + print the standard JSON envelope."""
    print_json_envelope(
        build_json_envelope(name=name, status=status, result=result, output=output, meta=meta)
    )
