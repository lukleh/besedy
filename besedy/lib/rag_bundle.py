"""Helpers for ColBERT bundle layout, validation, and active bundle resolution."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from besedy.core.paths import resolve_rag_colbert_root
from besedy.lib import rag_pylate
from besedy.lib.rag_chunk_corpus import slugify_backend_key, slugify_model_name

DEFAULT_COLBERT_BUNDLE_ROOT = resolve_rag_colbert_root()
ACTIVE_POINTER_PREFIX = "active_"


@dataclass(frozen=True)
class ColbertBundleArtifacts:
    """Paths to the files that make up one ColBERT bundle directory."""

    bundle_dir: Path
    colbert_index_dir: Path
    chunk_store_path: Path
    source_state_path: Path
    index_meta_path: Path
    chunk_manifest_path: Path


@dataclass(frozen=True)
class ResolvedColbertBundle:
    """A validated ColBERT bundle selected for one search scope."""

    artifacts: ColbertBundleArtifacts
    chunk_version: str
    built_at: str | None


def default_colbert_root(root_dir: Path | str | None = None) -> Path:
    """Return the base ColBERT bundle directory.

    Operators migrating from the old repo-local ``tmp/rag_colbert`` tree must
    move existing bundles into the resolved state root or rebuild them there.
    Besedy no longer falls back to the repo-local path automatically.
    """

    return Path(root_dir) if root_dir is not None else DEFAULT_COLBERT_BUNDLE_ROOT


def colbert_backend_scope_root(
    *,
    workflow_group_id: str,
    backend_key: str,
    root_dir: Path | str | None = None,
) -> Path:
    """Return the backend-level root that contains chunk-version directories."""

    return default_colbert_root(root_dir) / workflow_group_id / slugify_backend_key(backend_key)


def default_colbert_bundle_root(
    *,
    workflow_group_id: str,
    backend_key: str,
    chunk_version: str,
    colbert_model: str,
    root_dir: Path | str | None = None,
) -> Path:
    """Return the bundle root for one workflow/backend/model scope.

    The current on-disk layout keeps `chunk_version` in the path so the existing
    web route path contract remains stable until the route cutover happens.
    """

    return (
        colbert_backend_scope_root(
            workflow_group_id=workflow_group_id,
            backend_key=backend_key,
            root_dir=root_dir,
        )
        / chunk_version
        / slugify_model_name(colbert_model)
    )


def resolve_colbert_bundle_artifacts(bundle_dir: Path | str) -> ColbertBundleArtifacts:
    """Return the standard artifact paths for one ColBERT bundle directory."""

    root = Path(bundle_dir)
    return ColbertBundleArtifacts(
        bundle_dir=root,
        colbert_index_dir=root / "colbert_index",
        chunk_store_path=root / "chunk_store.sqlite",
        source_state_path=root / "source_state.sqlite",
        index_meta_path=root / "index_meta.json",
        chunk_manifest_path=root / "chunk_manifest.jsonl",
    )


def default_colbert_active_pointer_path(
    *,
    workflow_group_id: str,
    backend_key: str,
    colbert_model: str,
    root_dir: Path | str | None = None,
) -> Path:
    """Return the model-scoped active bundle pointer under one backend root."""

    return (
        colbert_backend_scope_root(
            workflow_group_id=workflow_group_id,
            backend_key=backend_key,
            root_dir=root_dir,
        )
        / f"{ACTIVE_POINTER_PREFIX}{slugify_model_name(colbert_model)}.json"
    )


def colbert_bundle_metadata_error_message(
    *, index_meta_path: Path, payload: dict[str, Any]
) -> str | None:
    retrieval_engine = payload.get("retrieval_engine")
    index_format_version = payload.get("index_format_version")
    plaid_backend = payload.get("plaid_backend")

    if retrieval_engine != rag_pylate.PYLATE_RETRIEVAL_ENGINE:
        return (
            "ColBERT bundle is incompatible with the current retrieval engine at "
            f"{index_meta_path}: expected retrieval_engine={rag_pylate.PYLATE_RETRIEVAL_ENGINE!r}, "
            f"found {retrieval_engine!r}. Rebuild it with `rag-colbert-index --rebuild`."
        )
    if index_format_version != rag_pylate.PYLATE_INDEX_FORMAT_VERSION:
        return (
            "ColBERT bundle uses an unsupported index format at "
            f"{index_meta_path}: expected index_format_version={rag_pylate.PYLATE_INDEX_FORMAT_VERSION!r}, "
            f"found {index_format_version!r}. Rebuild it with `rag-colbert-index --rebuild`."
        )
    if not isinstance(plaid_backend, str) or not plaid_backend.strip():
        return (
            "ColBERT bundle metadata is missing the PyLate backend identifier at "
            f"{index_meta_path}. Rebuild it with `rag-colbert-index --rebuild`."
        )
    try:
        rag_pylate.normalize_plaid_backend(plaid_backend)
    except ValueError as exc:
        return f"{exc} Rebuild the bundle with a supported PyLate backend."
    return None


def validate_colbert_bundle(
    bundle_dir: Path | str,
    *,
    require_compatible_engine: bool = True,
) -> ColbertBundleArtifacts:
    """Ensure that all runtime-critical artifacts exist for a ColBERT bundle."""

    bundle_path = Path(bundle_dir)
    if bundle_path.name == "colbert_index":
        bundle_path = bundle_path.parent
    artifacts = resolve_colbert_bundle_artifacts(bundle_path)
    missing = [
        path.name
        for path in (
            artifacts.colbert_index_dir,
            artifacts.chunk_store_path,
            artifacts.index_meta_path,
        )
        if not path.exists()
    ]
    if missing:
        raise FileNotFoundError(
            f"ColBERT bundle is incomplete at {artifacts.bundle_dir}: missing {', '.join(missing)}"
        )
    if require_compatible_engine:
        payload = _read_index_meta(artifacts.index_meta_path)
        error_message = colbert_bundle_metadata_error_message(
            index_meta_path=artifacts.index_meta_path,
            payload=payload,
        )
        if error_message is not None:
            raise RuntimeError(error_message)
    return artifacts


def write_colbert_active_pointer(
    *,
    workflow_group_id: str,
    backend_key: str,
    colbert_model: str,
    chunk_version: str,
    index_dir: Path | str,
    root_dir: Path | str | None = None,
) -> Path:
    """Persist the active bundle pointer for one backend/model search scope."""

    pointer_path = default_colbert_active_pointer_path(
        workflow_group_id=workflow_group_id,
        backend_key=backend_key,
        colbert_model=colbert_model,
        root_dir=root_dir,
    )
    pointer_path.parent.mkdir(parents=True, exist_ok=True)
    normalized_index_dir = Path(index_dir)
    if normalized_index_dir.name != "colbert_index":
        normalized_index_dir = normalized_index_dir / "colbert_index"
    payload = {
        "chunk_version": chunk_version,
        "index_dir": str(normalized_index_dir),
    }
    temp_path = pointer_path.with_suffix(".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(pointer_path)
    return pointer_path


def resolve_colbert_scope_bundle(
    *,
    workflow_group_id: str,
    backend_key: str,
    colbert_model: str,
    chunk_version: str | None = None,
    root_dir: Path | str | None = None,
    require_compatible_engine: bool = True,
) -> ResolvedColbertBundle | None:
    """Resolve the active validated ColBERT bundle for one search scope."""

    backend_root = colbert_backend_scope_root(
        workflow_group_id=workflow_group_id,
        backend_key=backend_key,
        root_dir=root_dir,
    )
    model_slug = slugify_model_name(colbert_model)

    if chunk_version is not None and chunk_version.strip():
        return _resolve_known_chunk_version_bundle(
            backend_root=backend_root,
            model_slug=model_slug,
            chunk_version=chunk_version.strip(),
            require_compatible_engine=require_compatible_engine,
        )

    pointer_path = default_colbert_active_pointer_path(
        workflow_group_id=workflow_group_id,
        backend_key=backend_key,
        colbert_model=colbert_model,
        root_dir=root_dir,
    )
    pointed_bundle = _resolve_pointed_bundle(
        pointer_path,
        require_compatible_engine=require_compatible_engine,
    )
    if pointed_bundle is not None:
        return pointed_bundle

    return _resolve_latest_valid_bundle(
        backend_root=backend_root,
        model_slug=model_slug,
        require_compatible_engine=require_compatible_engine,
    )


def _resolve_known_chunk_version_bundle(
    *,
    backend_root: Path,
    model_slug: str,
    chunk_version: str,
    require_compatible_engine: bool,
) -> ResolvedColbertBundle | None:
    bundle_link = backend_root / chunk_version / model_slug / "index"
    try:
        artifacts = validate_colbert_bundle(
            bundle_link, require_compatible_engine=require_compatible_engine
        )
    except FileNotFoundError:
        return None
    return ResolvedColbertBundle(
        artifacts=artifacts,
        chunk_version=chunk_version,
        built_at=_read_built_at(artifacts.index_meta_path),
    )


def _resolve_pointed_bundle(
    pointer_path: Path, *, require_compatible_engine: bool
) -> ResolvedColbertBundle | None:
    if not pointer_path.exists():
        return None

    try:
        payload = json.loads(pointer_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None

    index_dir = payload.get("index_dir")
    chunk_version = payload.get("chunk_version")
    if not isinstance(index_dir, str) or not index_dir.strip():
        return None
    if not isinstance(chunk_version, str) or not chunk_version.strip():
        return None

    try:
        artifacts = validate_colbert_bundle(
            Path(index_dir).parent,
            require_compatible_engine=require_compatible_engine,
        )
    except FileNotFoundError:
        return None
    return ResolvedColbertBundle(
        artifacts=artifacts,
        chunk_version=chunk_version,
        built_at=_read_built_at(artifacts.index_meta_path),
    )


def _resolve_latest_valid_bundle(
    *,
    backend_root: Path,
    model_slug: str,
    require_compatible_engine: bool,
) -> ResolvedColbertBundle | None:
    try:
        entries = list(backend_root.iterdir())
    except FileNotFoundError:
        return None

    candidates: list[ResolvedColbertBundle] = []
    first_incompatible_error: RuntimeError | None = None
    for entry in entries:
        if not entry.is_dir():
            continue
        chunk_version = entry.name
        bundle_link = entry / model_slug / "index"
        try:
            artifacts = validate_colbert_bundle(
                bundle_link, require_compatible_engine=require_compatible_engine
            )
        except FileNotFoundError:
            continue
        except RuntimeError as exc:
            if first_incompatible_error is None:
                first_incompatible_error = exc
            continue
        candidates.append(
            ResolvedColbertBundle(
                artifacts=artifacts,
                chunk_version=chunk_version,
                built_at=_read_built_at(artifacts.index_meta_path),
            )
        )

    if not candidates:
        if first_incompatible_error is not None:
            raise first_incompatible_error
        return None

    candidates.sort(
        key=lambda candidate: (
            candidate.built_at or "",
            candidate.chunk_version,
            str(candidate.artifacts.bundle_dir),
        ),
        reverse=True,
    )
    return candidates[0]


def _read_built_at(index_meta_path: Path) -> str | None:
    payload = _read_index_meta(index_meta_path)
    raw_value = payload.get("built_at")
    if isinstance(raw_value, str) and raw_value.strip():
        return raw_value
    return None


def _read_index_meta(index_meta_path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(index_meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


__all__ = [
    "ColbertBundleArtifacts",
    "ResolvedColbertBundle",
    "colbert_backend_scope_root",
    "colbert_bundle_metadata_error_message",
    "default_colbert_active_pointer_path",
    "default_colbert_root",
    "default_colbert_bundle_root",
    "resolve_colbert_bundle_artifacts",
    "resolve_colbert_scope_bundle",
    "validate_colbert_bundle",
    "write_colbert_active_pointer",
]
