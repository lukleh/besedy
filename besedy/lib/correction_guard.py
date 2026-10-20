"""Keep the staged audio of live correction workspaces unchanged (ADR 0012).

A correction workspace records the staged 16 kHz WAV its span times refer to,
and training rebuilds each chunk's audio from exactly that file. The web
application, which owns the correction database, writes ``workspace.json`` next
to each workspace's frozen source; this module reads those manifests so the
commands that delete or re-create staged audio leave those files alone.

Which manifests protect their audio:

- ``active`` always does.
- ``starting`` is written before the workspace's database transaction, so a
  fresh one protects like ``active``. One whose ``updated_at`` is older than
  :data:`STARTING_MANIFEST_MAX_AGE` is an abandoned start (the transaction
  failed and nothing cleaned up): it is ignored with a warning naming the path.
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
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from besedy.core.paths_runtime import resolve_corrections_root

MANIFEST_NAME = "workspace.json"
MANIFEST_SCHEMA_VERSION = 1
STARTING_MANIFEST_MAX_AGE = timedelta(hours=1)

logger = logging.getLogger(__name__)


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


def _parse_updated_at(value: object) -> datetime:
    if not isinstance(value, str):
        raise TypeError(f"updated_at must be a string, got {type(value).__name__}")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _protects(status: str, data: Mapping[str, object], manifest_path: Path, now: datetime) -> bool:
    if status == "active":
        return True
    if status != "starting":
        return False
    age = now - _parse_updated_at(data.get("updated_at"))
    if age <= STARTING_MANIFEST_MAX_AGE:
        return True
    logger.warning(
        "Ignoring correction workspace manifest %s: status 'starting' since %s "
        "(%s ago) is an abandoned start, not a live workspace",
        manifest_path,
        data.get("updated_at"),
        age,
    )
    return False


def load_protected_staged_audio(
    corrections_root: Path | None = None,
    *,
    now: datetime | None = None,
) -> dict[Path, ProtectedStagedAudio]:
    """Staged audio files live workspaces depend on, keyed by resolved path.

    ``now`` is the reference time for judging whether a ``starting`` manifest
    is abandoned; it defaults to the current UTC time.
    """
    root = corrections_root if corrections_root is not None else resolve_corrections_root()
    if not root.is_dir():
        return {}
    reference = now if now is not None else datetime.now(timezone.utc)
    protected: dict[Path, ProtectedStagedAudio] = {}
    for manifest_path in sorted(root.glob(f"corrections_*/*/{MANIFEST_NAME}")):
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            if data.get("schema_version") != MANIFEST_SCHEMA_VERSION:
                raise ValueError(f"unknown schema_version {data.get('schema_version')!r}")
            status = str(data["status"])
            staged = data["staged_audio"]
            entry = ProtectedStagedAudio(
                path=Path(staged["path"]),
                audio_hash=str(data["audio_hash"]),
                workspace_id=str(data["workspace_id"]),
                catalog_id=str(data["workflow_group_id"]),
            )
            protects = _protects(status, data, manifest_path, reference)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise CorrectionManifestError(
                f"Cannot read correction workspace manifest {manifest_path}: {exc}. "
                "Fix or restore it; until then nothing can tell which staged audio it protects."
            ) from exc
        if protects:
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
