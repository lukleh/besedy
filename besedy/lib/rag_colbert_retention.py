"""Explicit, conservative retention of unreferenced ColBERT bundle generations."""

from __future__ import annotations

import json
import os
import re
import shutil
from contextlib import ExitStack
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from besedy.lib.data.atomic_io import exclusive_lock
from besedy.lib.rag_bundle import (
    ACTIVE_POINTER_PREFIX,
    colbert_backend_scope_root,
    default_colbert_root,
    validate_colbert_bundle,
)
from besedy.lib.rag_chunk_corpus import slugify_model_name
from besedy.lib.rag_colbert import COLBERT_SYNC_LOCK_NAME
from besedy.lib.rag_retrieval_chunking import normalize_backend_key

DEFAULT_KEEP_BUNDLES = 3
DEFAULT_MIN_AGE_HOURS = 24
_GENERATION_NAME = re.compile(r"^index_(\d{8}_\d{6})(?:_(\d+))?$")


@dataclass
class BundleRetentionEntry:
    path: str
    size_bytes: int = 0
    keep_reasons: list[str] = field(default_factory=list)
    removed: bool = False


@dataclass
class BundleRetentionResult:
    root: str
    workflow_group_id: str
    backend_key: str
    colbert_model: str
    keep: int
    min_age_hours: int
    execute: bool
    entries: list[BundleRetentionEntry] = field(default_factory=list)


@dataclass(frozen=True)
class _Reference:
    path: Path
    target: Path


@dataclass(frozen=True)
class _PathActivity:
    modified_ns: int
    changed_ns: int
    device: int
    inode: int


@dataclass(frozen=True)
class _ReferenceSnapshot:
    references: list[_Reference]
    activity: dict[Path, _PathActivity]


def _path_activity(path: Path) -> _PathActivity:
    details = path.lstat()
    return _PathActivity(details.st_mtime_ns, details.st_ctime_ns, details.st_dev, details.st_ino)


def _reference_snapshot(root: Path) -> _ReferenceSnapshot:
    """Read references and global activity, including traces of vanished references.

    Directory mtimes preserve the last removal/atomic replacement even when the
    old reference no longer exists. Every pointer-file mtime matters too: an
    in-place repoint does not change its directory's mtime. Revision identities
    let execution detect changes since this snapshot without trusting mtimes alone.
    """
    references: list[_Reference] = []
    activity: dict[Path, _PathActivity] = {}

    def unreadable(error: OSError) -> None:
        raise error

    for directory, dirs, files in os.walk(root, followlinks=False, onerror=unreadable):
        activity[Path(directory)] = _path_activity(Path(directory))
        for name in [*dirs, *files]:
            path = Path(directory) / name
            if path.is_symlink():
                activity[path] = _path_activity(path)
                references.append(_Reference(path, path.resolve(strict=True)))
            if not (name.startswith(ACTIVE_POINTER_PREFIX) and name.endswith(".json")):
                continue
            try:
                activity[path] = _path_activity(path)
                # A symlinked pointer can be edited through its target without
                # changing either the symlink or its parent directory.
                if path.is_symlink():
                    pointer_target = path.resolve(strict=True)
                    activity[pointer_target] = _path_activity(pointer_target)
                payload = json.loads(path.read_text(encoding="utf-8"))
                target = payload["index_dir"]
                version = payload["chunk_version"]
                if not isinstance(target, str) or not target.strip():
                    raise ValueError("index_dir must be a nonempty string")
                if not isinstance(version, str) or not version.strip():
                    raise ValueError("chunk_version must be a nonempty string")
                resolved = Path(target).expanduser().resolve(strict=True)
                if resolved.name != "colbert_index" or not resolved.is_dir():
                    raise ValueError("index_dir must name an existing colbert_index directory")
                validate_colbert_bundle(resolved.parent, require_compatible_engine=False)
            except (OSError, ValueError, KeyError, TypeError) as exc:
                raise ValueError(
                    f"Cannot safely read active ColBERT pointer {path}: {exc}"
                ) from exc
            references.append(_Reference(path, resolved))
    return _ReferenceSnapshot(references, activity)


def _contains_reference(bundle: Path, references: list[_Reference]) -> bool:
    return any(
        reference.path.is_relative_to(bundle)
        or reference.target.is_relative_to(bundle)
        or (reference.target.is_dir() and bundle.is_relative_to(reference.target))
        for reference in references
    )


def _generation_order(path: Path) -> tuple[str, int]:
    match = _GENERATION_NAME.fullmatch(path.name)
    assert match is not None  # Only inspected managed generations are ordered.
    return match[1], int(match[2] or 0)


def _inspect_bundle(
    path: Path, root: Path, *, group: str, backend: str, model: str
) -> tuple[int, float]:
    if path.is_symlink() or path.resolve() != path or not path.is_relative_to(root):
        raise ValueError("bundle path contains a symlink or escapes the configured root")
    match = _GENERATION_NAME.fullmatch(path.name)
    if match is None:
        raise ValueError("not a managed timestamped bundle generation")
    datetime.strptime(match[1], "%Y%m%d_%H%M%S")
    artifacts = validate_colbert_bundle(path, require_compatible_engine=False)
    if not artifacts.colbert_index_dir.is_dir():
        raise ValueError("incomplete bundle: colbert_index is not a directory")
    for required in (
        artifacts.chunk_store_path,
        artifacts.index_meta_path,
        artifacts.source_state_path,
        artifacts.chunk_manifest_path,
    ):
        if not required.is_file():
            raise ValueError(f"incomplete bundle: missing file {required.name}")
    metadata = json.loads(artifacts.index_meta_path.read_text(encoding="utf-8"))
    expected = {
        "workflow_group_id": group,
        "backend_key": backend,
        "colbert_model": model,
        "chunk_version": path.parent.parent.name,
    }
    if not isinstance(metadata, dict) or any(
        metadata.get(key) != value for key, value in expected.items()
    ):
        raise ValueError(
            "bundle metadata does not match the selected catalog/backend/model/version"
        )
    size = 0
    modified = path.stat().st_mtime
    for entry in path.rglob("*"):
        if entry.is_symlink():
            raise ValueError(f"bundle contains a symlink: {entry}")
        details = entry.stat()
        modified = max(modified, details.st_mtime)
        if entry.is_file():
            size += details.st_size
    return size, modified


def prune_colbert_bundles(
    *,
    workflow_group_id: str,
    backend_key: str,
    colbert_model: str,
    keep: int = DEFAULT_KEEP_BUNDLES,
    min_age_hours: int = DEFAULT_MIN_AGE_HOURS,
    execute: bool = False,
    root_dir: Path | None = None,
    now: datetime | None = None,
) -> BundleRetentionResult:
    """Plan, or explicitly remove, old generations after a quiet reader grace period.

    The newest ``keep`` valid generations are retained across chunk versions,
    plus every referenced generation. Both bundle modification and the last
    root-wide reference/directory activity must be at least ``min_age_hours`` old. No automatic
    cleanup runs during indexing; callers must opt in to deletion here.
    """
    if keep < 1 or min_age_hours < 1:
        raise ValueError("keep and min_age_hours must be positive integers")
    if not re.fullmatch(r"\d{8}_\d{6}", workflow_group_id):
        raise ValueError("workflow_group_id must look like YYYYMMDD_HHMMSS")
    backend = normalize_backend_key(backend_key)
    root = default_colbert_root(root_dir).expanduser().resolve()
    result = BundleRetentionResult(
        str(root), workflow_group_id, backend, colbert_model, keep, min_age_hours, execute
    )
    backend_root = colbert_backend_scope_root(
        workflow_group_id=workflow_group_id, backend_key=backend, root_dir=root
    )
    if not backend_root.exists():
        return result
    if backend_root.resolve() != backend_root:
        raise ValueError("selected scope contains a symlink")
    model_slug = slugify_model_name(colbert_model)
    model_roots = sorted(
        version / model_slug
        for version in backend_root.iterdir()
        if version.is_dir()
        and not version.is_symlink()
        and (version / model_slug).is_dir()
        and not (version / model_slug).is_symlink()
    )
    cutoff = ((now or datetime.now(timezone.utc)) - timedelta(hours=min_age_hours)).timestamp()
    with ExitStack() as locks:
        for model_root in model_roots:
            locks.enter_context(exclusive_lock(model_root / COLBERT_SYNC_LOCK_NAME))
        # A foreign reference may have just been removed or repointed away.
        # Its former target is no longer discoverable, so any recent root-wide
        # reference/directory activity conservatively defers all pruning.
        snapshot = _reference_snapshot(root)
        expected_activity = snapshot.activity.copy()
        quiet = all(activity.modified_ns / 1e9 <= cutoff for activity in snapshot.activity.values())
        valid: list[tuple[Path, BundleRetentionEntry, float]] = []
        for model_root in model_roots:
            for path in sorted(model_root.iterdir()):
                if not (path.is_dir() or path.is_symlink()):
                    continue
                entry = BundleRetentionEntry(str(path))
                result.entries.append(entry)
                try:
                    entry.size_bytes, modified = _inspect_bundle(
                        path, root, group=workflow_group_id, backend=backend, model=colbert_model
                    )
                except (OSError, ValueError, TypeError) as exc:
                    entry.keep_reasons.append(str(exc))
                    continue
                valid.append((path, entry, modified))

        newest = {
            path
            for path, _, _ in sorted(
                valid, key=lambda item: _generation_order(item[0]), reverse=True
            )[:keep]
        }
        for path, entry, modified in valid:
            if path in newest:
                entry.keep_reasons.append(f"among the newest {keep} valid generations")
            if _contains_reference(path, snapshot.references):
                entry.keep_reasons.append("referenced by an active pointer or symlink")
            if modified > cutoff:
                entry.keep_reasons.append(f"bundle modified within {min_age_hours} hours")
            if not quiet:
                entry.keep_reasons.append(
                    f"root reference/directory activity within {min_age_hours} hours"
                )
            if not execute or entry.keep_reasons:
                continue
            # Recheck both existing references and activity left by vanished
            # references before every deletion, including changes elsewhere.
            current = _reference_snapshot(root)
            if _contains_reference(path, current.references):
                entry.keep_reasons.append("reference changed since retention was planned")
                continue
            if current.activity != expected_activity:
                entry.keep_reasons.append("root activity changed since retention was planned")
                continue
            _, modified = _inspect_bundle(
                path, root, group=workflow_group_id, backend=backend, model=colbert_model
            )
            if modified > cutoff:
                entry.keep_reasons.append("bundle changed since retention was planned")
                continue
            shutil.rmtree(path)
            entry.removed = True
            # A deletion removes its subtree and changes exactly its parent
            # directory. Acknowledge only those known changes: refreshing the
            # entire snapshot could hide a simultaneous foreign pointer removal.
            expected_activity = {
                key: activity
                for key, activity in expected_activity.items()
                if not key.is_relative_to(path)
            }
            expected_activity[path.parent] = _path_activity(path.parent)
    return result
