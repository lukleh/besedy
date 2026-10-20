"""Keep the staged audio of live correction workspaces unchanged (ADR 0012).

A correction workspace records the staged 16 kHz WAV its span times refer to,
and training rebuilds each chunk's audio from exactly that file. The web
application, which owns the correction database, writes ``workspace.json`` next
to each workspace's frozen source; this module reads those manifests so the
commands that delete or re-create staged audio leave those files alone.

Which manifests protect their audio:

- ``active`` does.
- ``starting`` does too, however old. The web writes it before the
  workspace's database transaction and rewrites it as ``active`` after the
  commit. Without the database this module cannot tell a start that crashed
  before its commit (an orphan, which holds one file needlessly) from one that
  crashed after it (a live workspace, whose audio must not go). The nightly
  integrity check, which sees the database, reports orphans for removal, and
  the web finishes the other kind the next time it locks the workspace.
- ``archived`` and any other status protect nothing.

A manifest that cannot be read stops the command rather than being skipped:
nothing could then tell which audio it protects. This is deliberately not
scoped to one catalog: a broken manifest under catalog A aborts ``clean``,
``remove`` and ``stage-audio --overwrite`` for catalog B too, because the
manifest, not the directory it sits in, says which staged file it guards.
The error names the manifest so the operator can fix or restore it.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from besedy.core.paths_runtime import resolve_corrections_root

MANIFEST_NAME = "workspace.json"
MANIFEST_SCHEMA_VERSION = 1
# Manifest statuses whose staged audio is kept (see the module docstring).
PROTECTING_STATUSES = frozenset({"active", "starting"})


class CorrectionManifestError(RuntimeError):
    """A workspace manifest exists but cannot be honoured."""


@dataclass(frozen=True)
class ProtectedStagedAudio:
    path: Path
    audio_hash: str
    workspace_id: str
    catalog_id: str


def _key(path: Path) -> Path:
    return path.expanduser().resolve(strict=False)


def manifest_paths(corrections_root: Path) -> list[Path]:
    """Every workspace manifest under the corrections root, in a stable order."""
    if not corrections_root.is_dir():
        return []
    return sorted(corrections_root.glob(f"corrections_*/*/{MANIFEST_NAME}"))


def read_manifest(manifest_path: Path) -> tuple[dict[str, Any], ProtectedStagedAudio]:
    """One manifest and the staged audio it names; unreadable ones raise."""
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        if data.get("schema_version") != MANIFEST_SCHEMA_VERSION:
            raise ValueError(f"unknown schema_version {data.get('schema_version')!r}")
        if not isinstance(data.get("status"), str):
            raise ValueError(f"status must be a string, got {data.get('status')!r}")
        staged = data["staged_audio"]
        entry = ProtectedStagedAudio(
            path=Path(staged["path"]),
            audio_hash=str(data["audio_hash"]),
            workspace_id=str(data["workspace_id"]),
            catalog_id=str(data["workflow_group_id"]),
        )
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        raise CorrectionManifestError(
            f"Cannot read correction workspace manifest {manifest_path}: {exc}. "
            "Fix or restore it; until then nothing can tell which staged audio it protects."
        ) from exc
    return data, entry


def load_protected_staged_audio(
    corrections_root: Path | None = None,
) -> dict[Path, ProtectedStagedAudio]:
    """Staged audio files live workspaces depend on, keyed by resolved path."""
    root = corrections_root if corrections_root is not None else resolve_corrections_root()
    protected: dict[Path, ProtectedStagedAudio] = {}
    for manifest_path in manifest_paths(root):
        data, entry = read_manifest(manifest_path)
        if data["status"] in PROTECTING_STATUSES:
            protected[_key(entry.path)] = entry
    return protected


def map_recorded_path(path: str, path_map: Mapping[str, str]) -> Path:
    """Apply the longest matching prefix mapping, as the web does for host paths."""
    for source in sorted(path_map, key=len, reverse=True):
        if path == source or path.startswith(source.rstrip("/") + "/"):
            return Path(path_map[source] + path[len(source) :])
    return Path(path)


def find_protected(
    path: Path, protected: Mapping[Path, ProtectedStagedAudio]
) -> ProtectedStagedAudio | None:
    """The live correction workspace entry depending on this staged file, if any."""
    if not protected:
        return None
    return protected.get(_key(path))


def is_protected(path: Path, protected: Mapping[Path, ProtectedStagedAudio]) -> bool:
    """Whether a live correction workspace depends on this staged file."""
    return find_protected(path, protected) is not None
