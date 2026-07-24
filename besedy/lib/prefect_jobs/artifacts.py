"""Artifact and output-bundle helpers for deep-search Prefect flows."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from prefect.artifacts import (
    create_link_artifact,
    create_markdown_artifact,
    create_table_artifact,
)

from .json_types import JsonDict


def write_output_bundle(
    *,
    root_dir: Path,
    flow_run_id: str,
    result: JsonDict,
    initial_hits: list[JsonDict],
    followup_trace: JsonDict,
    run_metadata: JsonDict,
) -> Path:
    bundle_dir = root_dir / flow_run_id
    bundle_dir.mkdir(parents=True, exist_ok=True)

    _write_json(bundle_dir / "result.json", result)
    _write_json(bundle_dir / "initial_hits.json", initial_hits)
    _write_json(bundle_dir / "followup_trace.json", followup_trace)
    _write_json(bundle_dir / "run_metadata.json", run_metadata)

    markdown = result.get("markdown")
    if isinstance(markdown, str):
        (bundle_dir / "report.md").write_text(markdown, encoding="utf-8")

    _chown_tree_from_env(bundle_dir)
    return bundle_dir


def publish_prefect_artifacts(
    *,
    flow_run_id: str,
    result: JsonDict,
    initial_hits: list[JsonDict],
    output_dir: Path,
) -> None:
    markdown = result.get("markdown")
    if isinstance(markdown, str) and markdown.strip():
        _safe_artifact_call(
            create_markdown_artifact,
            markdown=markdown,
            key=f"deep-search-report-{flow_run_id}",
            description="Final deep-search markdown report.",
        )

    if initial_hits:
        _safe_artifact_call(
            create_table_artifact,
            table=initial_hits,
            key=f"deep-search-initial-hits-{flow_run_id}",
            description="Initial retrieval hits for the deep-search run.",
        )

    _safe_artifact_call(
        create_link_artifact,
        link=output_dir.as_uri(),
        link_text=f"Output bundle for {flow_run_id}",
        key=f"deep-search-output-{flow_run_id}",
        description="Local output bundle for the deep-search run.",
    )


def _write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _chown_tree_from_env(path: Path) -> None:
    uid = _optional_int_env("BESEDY_OUTPUT_CHOWN_UID")
    gid = _optional_int_env("BESEDY_OUTPUT_CHOWN_GID")
    if uid is None and gid is None:
        return

    resolved_uid = -1 if uid is None else uid
    resolved_gid = -1 if gid is None else gid
    for candidate in (path, *path.rglob("*")):
        try:
            os.chown(candidate, resolved_uid, resolved_gid)
        except (AttributeError, FileNotFoundError, PermissionError, OSError):
            return


def _optional_int_env(name: str) -> int | None:
    raw = os.getenv(name, "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _safe_artifact_call(fn, /, **kwargs: Any) -> None:
    try:
        fn(**kwargs)
    except Exception:
        return
