"""Sync-support helpers for ColBERT bundle staging and cutover."""

from __future__ import annotations

import fcntl
import os
import shutil
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from besedy.core.symlinks import create_or_update_symlink
from besedy.lib.rag_bundle import (
    resolve_colbert_bundle_artifacts,
    resolve_colbert_scope_bundle,
    validate_colbert_bundle,
    write_colbert_active_pointer,
)
from besedy.lib.rag_chunk_corpus import TranscriptSource, build_chunks_for_transcript
from besedy.lib.rag_chunk_store import count_chunks_by_audio_hash, list_chunks
from besedy.lib.rag_colbert_artifacts import (
    _make_unique_bundle_dir,
    _remove_existing_path,
    _write_chunk_manifest,
    default_colbert_index_dir,
)
from besedy.lib.rag_colbert_source_state import ColbertSourceStateRow, read_source_state
from besedy.lib.rag_retrieval_types import RagChunk


@dataclass(frozen=True)
class _TranscriptDelta:
    source: TranscriptSource
    previous: ColbertSourceStateRow | None = None


@dataclass(frozen=True)
class _SyncClassification:
    added: list[_TranscriptDelta]
    updated: list[_TranscriptDelta]
    removed: list[ColbertSourceStateRow]
    unchanged: list[_TranscriptDelta]


def _copy_bundle_artifact(source: Path, destination: Path) -> None:
    if not source.exists():
        return
    if source.is_dir():
        shutil.copytree(source, destination)
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def _copy_bundle_to_staging(*, source_bundle_dir: Path, staging_bundle_dir: Path) -> None:
    if source_bundle_dir.resolve() == staging_bundle_dir.resolve():
        raise RuntimeError(
            "Refusing to stage ColBERT bundle in place. "
            f"source={source_bundle_dir} staging={staging_bundle_dir}"
        )
    source_artifacts = resolve_colbert_bundle_artifacts(source_bundle_dir)
    destination_artifacts = resolve_colbert_bundle_artifacts(staging_bundle_dir)
    if staging_bundle_dir.exists():
        _remove_existing_path(staging_bundle_dir)
    staging_bundle_dir.mkdir(parents=True, exist_ok=False)
    _copy_bundle_artifact(source_artifacts.colbert_index_dir, destination_artifacts.colbert_index_dir)
    _copy_bundle_artifact(source_artifacts.chunk_store_path, destination_artifacts.chunk_store_path)
    _copy_bundle_artifact(source_artifacts.source_state_path, destination_artifacts.source_state_path)
    _copy_bundle_artifact(source_artifacts.index_meta_path, destination_artifacts.index_meta_path)
    _copy_bundle_artifact(source_artifacts.chunk_manifest_path, destination_artifacts.chunk_manifest_path)


def _rewrite_chunk_manifest_from_store(*, bundle_dir: Path) -> None:
    artifacts = resolve_colbert_bundle_artifacts(bundle_dir)
    chunks = list_chunks(path=artifacts.chunk_store_path)
    _write_chunk_manifest(target_dir=bundle_dir, chunks=chunks)


def _validate_source_state_consistency(*, bundle_dir: Path) -> None:
    artifacts = resolve_colbert_bundle_artifacts(bundle_dir)
    source_state = read_source_state(artifacts.source_state_path)
    chunk_counts = count_chunks_by_audio_hash(path=artifacts.chunk_store_path)
    if not source_state:
        if chunk_counts:
            raise RuntimeError(
                "ColBERT source_state.sqlite is empty but chunk_store.sqlite contains chunks."
            )
        return

    for audio_hash, row in source_state.items():
        actual_chunk_count = int(chunk_counts.get(audio_hash, 0))
        if actual_chunk_count != row.chunk_count:
            raise RuntimeError(
                "ColBERT source_state.sqlite does not match chunk_store.sqlite for "
                f"{audio_hash}: expected {row.chunk_count}, got {actual_chunk_count}."
            )


def _validate_bundle_artifacts_for_sync(*, bundle_dir: Path) -> None:
    artifacts = validate_colbert_bundle(bundle_dir)
    _validate_source_state_consistency(bundle_dir=bundle_dir)

    from besedy.lib.rag_colbert_artifacts import _read_index_meta

    meta = _read_index_meta(bundle_dir)
    chunk_count = int(meta.get("chunk_count", 0))
    actual_chunk_count = len(list_chunks(path=artifacts.chunk_store_path))
    if chunk_count != actual_chunk_count:
        raise RuntimeError(
            "ColBERT bundle metadata does not match chunk_store.sqlite: "
            f"expected {chunk_count} chunks, found {actual_chunk_count}."
        )


@contextmanager
def _colbert_scope_lock(lock_path: Path):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            handle.seek(0)
            handle.truncate()
            handle.write(str(os.getpid()))
            handle.flush()
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _classify_sources(
    *,
    current_sources: dict[str, TranscriptSource],
    previous_rows: dict[str, ColbertSourceStateRow],
    force: bool,
    target_audio_hash: str | None,
) -> _SyncClassification:
    added: list[_TranscriptDelta] = []
    updated: list[_TranscriptDelta] = []
    removed: list[ColbertSourceStateRow] = []
    unchanged: list[_TranscriptDelta] = []

    if target_audio_hash is not None:
        source = current_sources.get(target_audio_hash)
        if source is None:
            raise FileNotFoundError(
                f"Requested audio hash is not present in the current transcript scope: {target_audio_hash}"
            )
        previous = previous_rows.get(target_audio_hash)
        delta = _TranscriptDelta(source=source, previous=previous)
        if previous is None:
            added.append(delta)
        elif (
            force
            or previous.transcript_path != source.transcript_path
            or previous.transcript_fingerprint != source.transcript_fingerprint
        ):
            updated.append(delta)
        else:
            unchanged.append(delta)
        return _SyncClassification(added=added, updated=updated, removed=removed, unchanged=unchanged)

    for audio_hash, source in sorted(current_sources.items()):
        previous = previous_rows.get(audio_hash)
        delta = _TranscriptDelta(source=source, previous=previous)
        if previous is None:
            added.append(delta)
            continue
        if (
            force
            or previous.transcript_path != source.transcript_path
            or previous.transcript_fingerprint != source.transcript_fingerprint
        ):
            updated.append(delta)
            continue
        unchanged.append(delta)

    for audio_hash, previous in sorted(previous_rows.items()):
        if audio_hash not in current_sources:
            removed.append(previous)

    return _SyncClassification(
        added=added,
        updated=updated,
        removed=removed,
        unchanged=unchanged,
    )


def _source_state_requires_rebuild(
    *,
    previous_rows: dict[str, ColbertSourceStateRow],
    chunking_fingerprint: str,
    bundle_fingerprint: str,
) -> bool:
    return any(
        row.chunking_fingerprint != chunking_fingerprint
        or row.bundle_fingerprint != bundle_fingerprint
        for row in previous_rows.values()
    )


def _build_chunks_for_source(
    *,
    source: TranscriptSource,
    transcripts_root: Path,
    workflow_group_id: str,
    backend_key: str,
    run_id: str,
    min_chunk_tokens: int,
    max_chunk_tokens: int,
    overlap_tokens: int,
    chunk_tokenizer_model: str,
) -> list[RagChunk]:
    chunks, _windows = build_chunks_for_transcript(
        transcript_path=Path(source.transcript_path),
        transcripts_root=transcripts_root,
        workflow_group_id=workflow_group_id,
        backend_key=backend_key,
        run_id=run_id,
        min_chunk_tokens=min_chunk_tokens,
        max_chunk_tokens=max_chunk_tokens,
        overlap_tokens=overlap_tokens,
        chunk_tokenizer_model=chunk_tokenizer_model,
    )
    return chunks


def _replace_explicit_bundle_dir(*, target_dir: Path, staging_dir: Path) -> None:
    backup_dir = target_dir.parent / f"{target_dir.name}.backup.{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    if target_dir.exists() or target_dir.is_symlink():
        if backup_dir.exists() or backup_dir.is_symlink():
            _remove_existing_path(backup_dir)
        target_dir.rename(backup_dir)
    try:
        staging_dir.rename(target_dir)
    except Exception:
        if backup_dir.exists() and not target_dir.exists():
            backup_dir.rename(target_dir)
        raise
    _remove_existing_path(backup_dir)


def _resolve_sync_bundle_context(
    *,
    workflow_group_id: str,
    backend_key: str,
    colbert_model: str,
    chunk_version: str,
    index_dir: Path | str | None,
) -> tuple[Path, Path | None, Path]:
    if index_dir is not None:
        explicit_dir = Path(index_dir)
        existing_dir = explicit_dir if explicit_dir.exists() else None
        staging_dir = _make_unique_bundle_dir(
            parent=explicit_dir.parent,
            stem=f"{explicit_dir.name}.staging",
        )
        return explicit_dir, existing_dir, staging_dir

    exposed_index_dir = default_colbert_index_dir(
        workflow_group_id=workflow_group_id,
        backend_key=backend_key,
        chunk_version=chunk_version,
        colbert_model=colbert_model,
    )
    resolved_bundle = resolve_colbert_scope_bundle(
        workflow_group_id=workflow_group_id,
        backend_key=backend_key,
        colbert_model=colbert_model,
        require_compatible_engine=False,
    )
    staging_dir = _make_unique_bundle_dir(parent=exposed_index_dir.parent, stem="index")
    return exposed_index_dir, (resolved_bundle.artifacts.bundle_dir if resolved_bundle is not None else None), staging_dir


def _cutover_staged_bundle(
    *,
    exposed_index_dir: Path,
    staging_dir: Path,
    workflow_group_id: str,
    backend_key: str,
    colbert_model: str,
    chunk_version: str,
    explicit_index_dir: bool,
) -> None:
    if explicit_index_dir:
        _replace_explicit_bundle_dir(target_dir=exposed_index_dir, staging_dir=staging_dir)
        return

    create_or_update_symlink(exposed_index_dir, staging_dir, description="ColBERT index")
    write_colbert_active_pointer(
        workflow_group_id=workflow_group_id,
        backend_key=backend_key,
        colbert_model=colbert_model,
        chunk_version=chunk_version,
        index_dir=exposed_index_dir,
    )
