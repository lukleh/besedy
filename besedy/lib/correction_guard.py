"""Keep the staged audio of live correction workspaces unchanged (ADR 0012).

A correction workspace records the staged 16 kHz WAV its span times refer to,
and training rebuilds each chunk's audio from exactly that file. The web
application, which owns the correction database, writes ``workspace.json`` next
to each workspace's frozen source; this module reads those manifests so the
commands that delete or re-create staged audio leave those files alone.

A manifest that cannot be read stops the command rather than being skipped:
nothing could then tell which audio it protects.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from besedy.core.paths_runtime import resolve_corrections_root

MANIFEST_NAME = "workspace.json"
MANIFEST_SCHEMA_VERSION = 1


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


def load_protected_staged_audio(
    corrections_root: Path | None = None,
) -> dict[Path, ProtectedStagedAudio]:
    """Staged audio files live workspaces depend on, keyed by resolved path."""
    root = corrections_root if corrections_root is not None else resolve_corrections_root()
    if not root.is_dir():
        return {}
    protected: dict[Path, ProtectedStagedAudio] = {}
    for manifest_path in sorted(root.glob(f"corrections_*/*/{MANIFEST_NAME}")):
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            if data.get("schema_version") != MANIFEST_SCHEMA_VERSION:
                raise ValueError(f"unknown schema_version {data.get('schema_version')!r}")
            status = data["status"]
            staged = data["staged_audio"]
            entry = ProtectedStagedAudio(
                path=Path(staged["path"]),
                audio_hash=str(data["audio_hash"]),
                workspace_id=str(data["workspace_id"]),
                catalog_id=str(data["workflow_group_id"]),
            )
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise CorrectionManifestError(
                f"Cannot read correction workspace manifest {manifest_path}: {exc}. "
                "Fix or restore it; until then nothing can tell which staged audio it protects."
            ) from exc
        if status == "active":
            protected[_key(entry.path)] = entry
    return protected


def map_recorded_path(path: str, path_map: Mapping[str, str]) -> Path:
    """Apply the longest matching prefix mapping, as the web does for host paths."""
    for source in sorted(path_map, key=len, reverse=True):
        if path == source or path.startswith(source.rstrip("/") + "/"):
            return Path(path_map[source] + path[len(source) :])
    return Path(path)


def is_protected(path: Path, protected: Mapping[Path, ProtectedStagedAudio]) -> bool:
    """Whether a live correction workspace depends on this staged file."""
    return bool(protected) and _key(path) in protected
