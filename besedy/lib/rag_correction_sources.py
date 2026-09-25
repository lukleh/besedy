"""Effective transcript sources for search indexing.

Search indexes whatever text is currently the transcript of a recording. Once
a corrected transcript has been published, that is the corrected text; until
then it is the configured machine transcript. This module answers that question
for one catalog, and it is the only place that knows corrections exist.

The web application owns the correction database, but an index build has no
database. The two sides already share a filesystem, so the web application
publishes the effective search source for an audio hash as a small pointer
file, exactly as transcripts themselves are published as files. The pointer
carries the artifact's own SHA-256, not an index source fingerprint: those are
different identities with different owners, and treating one as the other
would look like verification while being a coincidence. A pointer in
``activating`` state is honoured as readily as an ``active`` one: during the
window where a publication has written its artifacts but has not yet committed
its database pointers, a routine sync must resolve the new text, or it would
classify the hash as changed and revert the corrected chunks.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from besedy.core.paths_runtime import resolve_corrections_root

LOGGER = logging.getLogger(__name__)

POINTER_SCHEMA_VERSION = 2
POINTER_DIR_NAME = "index-sources"
ACTIVE_POINTER_STATES = frozenset({"activating", "active"})


@dataclass(frozen=True)
class CorrectionIndexPointer:
    """One catalog's claim about the effective transcript for an audio hash."""

    workflow_group_id: str
    audio_hash: str
    workspace_id: str
    publication_id: str
    state: str
    backend: str
    transcript_path: Path
    artifact_sha256: str


@dataclass(frozen=True)
class EffectiveTranscriptSource:
    """A transcript file to index, and where it came from."""

    audio_hash: str
    transcript_path: Path
    origin: str  # "machine" or "correction"
    publication_id: str | None = None
    artifact_sha256: str | None = None


def resolve_catalog_corrections_root(
    workflow_group_id: str,
    *,
    corrections_root: Path | str | None = None,
) -> Path:
    return resolve_corrections_root(corrections_root) / f"corrections_{workflow_group_id}"


def _parse_pointer(
    path: Path,
    *,
    corrections_root: Path,
    workflow_group_id: str,
) -> CorrectionIndexPointer | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        LOGGER.warning("Skipping unreadable correction pointer %s (%s)", path, exc)
        return None

    if not isinstance(payload, dict):
        LOGGER.warning("Skipping malformed correction pointer %s", path)
        return None

    if payload.get("schema_version") != POINTER_SCHEMA_VERSION:
        LOGGER.warning(
            "Skipping correction pointer %s with unsupported schema_version %r",
            path,
            payload.get("schema_version"),
        )
        return None

    state = str(payload.get("state") or "")
    if state not in ACTIVE_POINTER_STATES:
        return None

    if payload.get("workflow_group_id") != workflow_group_id:
        LOGGER.warning(
            "Skipping correction pointer %s belonging to catalog %r",
            path,
            payload.get("workflow_group_id"),
        )
        return None

    audio_hash = str(payload.get("audio_hash") or "")
    relative_path = str(payload.get("transcript_path") or "")
    artifact_sha256 = str(payload.get("artifact_sha256") or "")
    if not audio_hash or not relative_path or not artifact_sha256:
        LOGGER.warning("Skipping incomplete correction pointer %s", path)
        return None

    transcript_path = (corrections_root / relative_path).resolve()
    try:
        transcript_path.relative_to(corrections_root.resolve())
    except ValueError:
        LOGGER.warning(
            "Skipping correction pointer %s whose transcript escapes the corrections root",
            path,
        )
        return None

    return CorrectionIndexPointer(
        workflow_group_id=workflow_group_id,
        audio_hash=audio_hash,
        workspace_id=str(payload.get("workspace_id") or ""),
        publication_id=str(payload.get("publication_id") or ""),
        state=state,
        backend=str(payload.get("backend") or ""),
        transcript_path=transcript_path,
        artifact_sha256=artifact_sha256,
    )


def _artifact_matches(pointer: CorrectionIndexPointer) -> bool:
    """Check the transcript's bytes against the hash the pointer carries.

    This is the boundary that consumes the artifact, so it is where the hash is
    worth anything. Comparing the pointer's hash against the database value
    that produced it would only prove that two pieces of metadata agree; a
    truncated write, a half-copied tree or an edited file would pass.
    """
    digest = hashlib.sha256()
    try:
        with pointer.transcript_path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as exc:
        LOGGER.warning("Could not read correction transcript %s (%s)", pointer.transcript_path, exc)
        return False

    if digest.hexdigest() != pointer.artifact_sha256:
        LOGGER.warning(
            "Correction transcript %s does not match its recorded hash; ignoring it",
            pointer.transcript_path,
        )
        return False

    return True


def load_correction_index_pointers(
    workflow_group_id: str,
    *,
    corrections_root: Path | str | None = None,
) -> dict[str, CorrectionIndexPointer]:
    """Read every usable pointer for one catalog, keyed by audio hash."""

    try:
        root = resolve_corrections_root(corrections_root)
    except RuntimeError as exc:
        LOGGER.debug("No corrections root configured (%s)", exc)
        return {}

    pointer_dir = root / f"corrections_{workflow_group_id}" / POINTER_DIR_NAME
    if not pointer_dir.is_dir():
        return {}

    pointers: dict[str, CorrectionIndexPointer] = {}
    for path in sorted(pointer_dir.glob("*.json")):
        pointer = _parse_pointer(
            path,
            corrections_root=root,
            workflow_group_id=workflow_group_id,
        )
        if pointer is None:
            continue
        if not pointer.transcript_path.is_file():
            LOGGER.warning(
                "Correction pointer %s names a missing transcript %s",
                path,
                pointer.transcript_path,
            )
            continue
        if not _artifact_matches(pointer):
            continue
        pointers[pointer.audio_hash] = pointer

    return pointers


def resolve_effective_transcript_sources(
    *,
    workflow_group_id: str,
    machine_transcripts: Iterable[tuple[str, Path]],
    corrections_root: Path | str | None = None,
) -> list[EffectiveTranscriptSource]:
    """Resolve what to index for one backend scope.

    ``machine_transcripts`` is the discovered ``(audio_hash, path)`` pairs for
    the scope. A corrected publication replaces the machine transcript for its
    audio hash and is also included when the hash has no machine transcript in
    this scope, because a corrected transcript is the transcript of that
    recording rather than an alternative backend for it.
    """

    pointers = load_correction_index_pointers(
        workflow_group_id,
        corrections_root=corrections_root,
    )

    resolved: list[EffectiveTranscriptSource] = []
    seen: set[str] = set()

    for audio_hash, transcript_path in machine_transcripts:
        seen.add(audio_hash)
        pointer = pointers.get(audio_hash)
        if pointer is None:
            resolved.append(
                EffectiveTranscriptSource(
                    audio_hash=audio_hash,
                    transcript_path=transcript_path,
                    origin="machine",
                )
            )
            continue
        resolved.append(
            EffectiveTranscriptSource(
                audio_hash=audio_hash,
                transcript_path=pointer.transcript_path,
                origin="correction",
                publication_id=pointer.publication_id,
                artifact_sha256=pointer.artifact_sha256,
            )
        )

    for audio_hash, pointer in pointers.items():
        if audio_hash in seen:
            continue
        resolved.append(
            EffectiveTranscriptSource(
                audio_hash=audio_hash,
                transcript_path=pointer.transcript_path,
                origin="correction",
                publication_id=pointer.publication_id,
                artifact_sha256=pointer.artifact_sha256,
            )
        )

    resolved.sort(key=lambda source: source.audio_hash)
    return resolved
