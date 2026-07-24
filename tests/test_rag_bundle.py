from __future__ import annotations

import json
from pathlib import Path

import pytest

from besedy.commands.catalog.symlink import create_or_update_symlink
from besedy.lib.rag_bundle import (
    default_colbert_bundle_root,
    resolve_colbert_scope_bundle,
    validate_colbert_bundle,
    write_colbert_active_pointer,
)
from besedy.lib.rag_pylate import (
    DEFAULT_PYLATE_PLAID_BACKEND,
    PYLATE_INDEX_FORMAT_VERSION,
    PYLATE_RETRIEVAL_ENGINE,
)

WORKFLOW_GROUP_ID = "20260206_120000"
BACKEND_KEY = "faster-whisper/large-v3@silero_vad_v6"
COLBERT_MODEL = "jinaai/jina-colbert-v2"


def _write_bundle(
    *,
    root_dir: Path,
    chunk_version: str,
    timestamp: str,
    built_at: str,
    complete: bool = True,
) -> Path:
    model_root = default_colbert_bundle_root(
        workflow_group_id=WORKFLOW_GROUP_ID,
        backend_key=BACKEND_KEY,
        chunk_version=chunk_version,
        colbert_model=COLBERT_MODEL,
        root_dir=root_dir,
    )
    model_root.mkdir(parents=True, exist_ok=True)
    bundle_dir = model_root / f"index_{timestamp}"
    bundle_dir.mkdir()
    (bundle_dir / "colbert_index").mkdir()
    if complete:
        (bundle_dir / "chunk_store.sqlite").write_bytes(b"sqlite")
    (bundle_dir / "index_meta.json").write_text(
        json.dumps(
            {
                "chunk_version": chunk_version,
                "built_at": built_at,
                "retrieval_engine": PYLATE_RETRIEVAL_ENGINE,
                "retrieval_engine_version": "1.4.0",
                "index_format_version": PYLATE_INDEX_FORMAT_VERSION,
                "plaid_backend": DEFAULT_PYLATE_PLAID_BACKEND,
            }
        ),
        encoding="utf-8",
    )
    create_or_update_symlink(model_root / "index", bundle_dir, description="ColBERT index")
    return bundle_dir


def test_validate_colbert_bundle_requires_chunk_store(tmp_path: Path) -> None:
    bundle_dir = _write_bundle(
        root_dir=tmp_path,
        chunk_version="v2",
        timestamp="20260403_100000",
        built_at="2026-04-03T10:00:00Z",
        complete=False,
    )

    with pytest.raises(FileNotFoundError, match="chunk_store.sqlite"):
        validate_colbert_bundle(bundle_dir)


def test_validate_colbert_bundle_rejects_incompatible_engine(tmp_path: Path) -> None:
    bundle_dir = _write_bundle(
        root_dir=tmp_path,
        chunk_version="v2",
        timestamp="20260403_100000",
        built_at="2026-04-03T10:00:00Z",
    )
    (bundle_dir / "index_meta.json").write_text(
        json.dumps({"chunk_version": "v2", "built_at": "2026-04-03T10:00:00Z"}),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="rag-colbert-index --rebuild"):
        validate_colbert_bundle(bundle_dir)


def test_resolve_colbert_scope_bundle_can_find_incompatible_bundle_for_rebuild(
    tmp_path: Path,
) -> None:
    bundle_dir = _write_bundle(
        root_dir=tmp_path,
        chunk_version="v2",
        timestamp="20260403_100000",
        built_at="2026-04-03T10:00:00Z",
    )
    (bundle_dir / "index_meta.json").write_text(
        json.dumps({"chunk_version": "v2", "built_at": "2026-04-03T10:00:00Z"}),
        encoding="utf-8",
    )

    resolved = resolve_colbert_scope_bundle(
        workflow_group_id=WORKFLOW_GROUP_ID,
        backend_key=BACKEND_KEY,
        colbert_model=COLBERT_MODEL,
        root_dir=tmp_path,
        require_compatible_engine=False,
    )

    assert resolved is not None
    assert resolved.chunk_version == "v2"


def test_resolve_colbert_scope_bundle_prefers_active_pointer(tmp_path: Path) -> None:
    _write_bundle(
        root_dir=tmp_path,
        chunk_version="v3",
        timestamp="20260403_120000",
        built_at="2026-04-03T12:00:00Z",
    )
    pointed_bundle = _write_bundle(
        root_dir=tmp_path,
        chunk_version="v2",
        timestamp="20260403_110000",
        built_at="2026-04-03T11:00:00Z",
    )
    write_colbert_active_pointer(
        workflow_group_id=WORKFLOW_GROUP_ID,
        backend_key=BACKEND_KEY,
        colbert_model=COLBERT_MODEL,
        chunk_version="v2",
        index_dir=pointed_bundle.parent / "index",
        root_dir=tmp_path,
    )

    resolved = resolve_colbert_scope_bundle(
        workflow_group_id=WORKFLOW_GROUP_ID,
        backend_key=BACKEND_KEY,
        colbert_model=COLBERT_MODEL,
        root_dir=tmp_path,
    )

    assert resolved is not None
    assert resolved.chunk_version == "v2"


def test_resolve_colbert_scope_bundle_selects_latest_valid_bundle(tmp_path: Path) -> None:
    _write_bundle(
        root_dir=tmp_path,
        chunk_version="v2",
        timestamp="20260403_090000",
        built_at="2026-04-03T09:00:00Z",
    )
    _write_bundle(
        root_dir=tmp_path,
        chunk_version="v3",
        timestamp="20260403_100000",
        built_at="2026-04-03T10:00:00Z",
    )

    resolved = resolve_colbert_scope_bundle(
        workflow_group_id=WORKFLOW_GROUP_ID,
        backend_key=BACKEND_KEY,
        colbert_model=COLBERT_MODEL,
        root_dir=tmp_path,
    )

    assert resolved is not None
    assert resolved.chunk_version == "v3"


def test_resolve_colbert_scope_bundle_ignores_incomplete_bundle(tmp_path: Path) -> None:
    _write_bundle(
        root_dir=tmp_path,
        chunk_version="v2",
        timestamp="20260403_090000",
        built_at="2026-04-03T09:00:00Z",
    )
    _write_bundle(
        root_dir=tmp_path,
        chunk_version="v3",
        timestamp="20260403_100000",
        built_at="2026-04-03T10:00:00Z",
        complete=False,
    )

    resolved = resolve_colbert_scope_bundle(
        workflow_group_id=WORKFLOW_GROUP_ID,
        backend_key=BACKEND_KEY,
        colbert_model=COLBERT_MODEL,
        root_dir=tmp_path,
    )

    assert resolved is not None
    assert resolved.chunk_version == "v2"
