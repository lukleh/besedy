"""Shared chunk-corpus builders for experimental retrievers."""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from besedy.core.paths import (
    parse_transcript_components,
    require_run_id_from_transcripts_root,
    resolve_transcripts_root,
    sanitize_component,
)
from besedy.lib.data.encoding import load_json_with_fallback
from besedy.lib.rag_retrieval_chunking import (
    CHUNK_MAX_SEGMENT_TOKENS,
    CHUNK_VERSION,
    # Shared chunk-corpus code intentionally reuses the canonical transcript discovery
    # and audio-hash inference helpers so DB and sidecar retrievers stay identical.
    _discover_backend_transcripts,
    _infer_audio_hash,
    _segments_from_transcript,
    chunk_segments,
    get_chunk_token_counter,
    normalize_backend_key,
    split_segments_for_chunking,
    summarize_chunk_windows,
)
from besedy.lib.rag_retrieval_types import ChunkTokenDistribution, ChunkWindow, RagChunk

LOGGER = logging.getLogger(__name__)


class DuplicateTranscriptAudioHashError(ValueError):
    """Raised when multiple transcript files resolve to the same canonical audio hash."""


@dataclass(frozen=True)
class ChunkCorpusBuild:
    workflow_group_id: str
    backend_key: str
    run_id: str
    transcripts_root: str
    transcript_files: int
    transcripts_skipped: int
    chunk_version: str
    chunks: list[RagChunk]
    chunk_distribution: ChunkTokenDistribution


@dataclass(frozen=True)
class TranscriptSource:
    audio_hash: str
    transcript_path: str
    transcript_fingerprint: str


@dataclass(frozen=True)
class TranscriptSourceBuild:
    workflow_group_id: str
    backend_key: str
    run_id: str
    transcripts_root: str
    transcript_files: int
    transcripts_skipped: int
    sources: list[TranscriptSource]


def _get_chunk_token_counter(*, chunk_tokenizer_model: str | None):
    normalized_model = chunk_tokenizer_model.strip() if chunk_tokenizer_model else ""
    if not normalized_model:
        return get_chunk_token_counter()

    # Some tests monkeypatch get_chunk_token_counter() with a zero-arg lambda.
    try:
        return get_chunk_token_counter(model_name=normalized_model)
    except TypeError:
        return get_chunk_token_counter()


def _register_unique_transcript_audio_hash(
    *,
    audio_hash: str,
    transcript_path: Path,
    transcript_paths_by_hash: dict[str, str],
) -> None:
    normalized_path = str(transcript_path)
    previous_path = transcript_paths_by_hash.get(audio_hash)
    if previous_path is None or previous_path == normalized_path:
        transcript_paths_by_hash[audio_hash] = normalized_path
        return

    raise DuplicateTranscriptAudioHashError(
        "Multiple transcript files resolve to the same canonical audio hash "
        f"{audio_hash}: {previous_path} and {normalized_path}"
    )


def slugify_backend_key(backend_key: str) -> str:
    """Return a filesystem-safe backend slug."""

    return sanitize_component(backend_key) or "backend"


def slugify_model_name(model_name: str) -> str:
    """Return a filesystem-safe model slug."""

    return sanitize_component(model_name) or "model"


def make_chunk_id(
    *,
    workflow_group_id: str,
    backend_key: str,
    audio_hash: str,
    start_sec: float,
    end_sec: float,
    chunk_version: str = CHUNK_VERSION,
) -> str:
    """Build the stable chunk identifier shared across RAG bundle artifacts."""

    start_ms = int(round(start_sec * 1000))
    end_ms = int(round(end_sec * 1000))
    payload = f"{workflow_group_id}|{backend_key}|{audio_hash}|{start_ms}|{end_ms}|{chunk_version}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _stable_fingerprint(payload: dict[str, Any]) -> str:
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def build_transcript_source(
    *,
    transcript_path: Path,
    transcripts_root: Path,
    backend_key: str,
    chunk_tokenizer_model: str | None = None,
    token_counter=None,
) -> TranscriptSource:
    """Build the canonical transcript source state for one transcript file."""

    chunk_token_counter = token_counter or _get_chunk_token_counter(
        chunk_tokenizer_model=chunk_tokenizer_model,
    )

    data = load_json_with_fallback(transcript_path)
    if not isinstance(data, dict):
        raise ValueError(f"Invalid transcript JSON: {transcript_path}")

    components = parse_transcript_components(transcript_path, transcripts_root)
    if components is None:
        raise ValueError(f"Transcript path is outside transcripts root: {transcript_path}")

    workflow, model_component, hash_component = components
    file_backend = f"{workflow}/{model_component}"
    if file_backend != backend_key:
        raise ValueError(f"Transcript backend mismatch for {transcript_path}: {file_backend}")

    audio_hash = _infer_audio_hash(hash_component, data)
    if audio_hash is None:
        raise ValueError(f"Could not infer audio hash from transcript: {transcript_path}")

    segments = _segments_from_transcript(data, token_counter=chunk_token_counter)
    transcript_fingerprint = _stable_fingerprint(
        {
            "audio_hash": audio_hash,
            "segments": [
                {
                    "start": round(float(segment.start), 6),
                    "end": round(float(segment.end), 6),
                    "text": segment.text,
                }
                for segment in segments
            ],
        }
    )
    return TranscriptSource(
        audio_hash=audio_hash,
        transcript_path=str(transcript_path),
        transcript_fingerprint=transcript_fingerprint,
    )


def discover_transcript_sources(
    *,
    workflow_group_id: str,
    backend_key: str,
    transcripts_root: Path | str | None = None,
    chunk_tokenizer_model: str | None = None,
) -> TranscriptSourceBuild:
    """Discover transcript sources and fingerprints for one transcript backend scope."""

    normalized_backend = normalize_backend_key(backend_key)
    resolved_transcripts_root = resolve_transcripts_root(transcripts_root)
    if resolved_transcripts_root.is_symlink():
        resolved_transcripts_root = resolved_transcripts_root.resolve()
    run_id = require_run_id_from_transcripts_root(resolved_transcripts_root)
    transcript_paths = _discover_backend_transcripts(resolved_transcripts_root, normalized_backend)
    token_counter = _get_chunk_token_counter(
        chunk_tokenizer_model=chunk_tokenizer_model,
    )

    sources_by_hash: dict[str, TranscriptSource] = {}
    transcript_paths_by_hash: dict[str, str] = {}
    skipped = 0
    for transcript_path in transcript_paths:
        try:
            source = build_transcript_source(
                transcript_path=transcript_path,
                transcripts_root=resolved_transcripts_root,
                backend_key=normalized_backend,
                chunk_tokenizer_model=chunk_tokenizer_model,
                token_counter=token_counter,
            )
            _register_unique_transcript_audio_hash(
                audio_hash=source.audio_hash,
                transcript_path=transcript_path,
                transcript_paths_by_hash=transcript_paths_by_hash,
            )
        except DuplicateTranscriptAudioHashError:
            raise
        except (ValueError, FileNotFoundError) as exc:
            skipped += 1
            LOGGER.debug(
                "Skipping transcript during source discovery: %s (%s)", transcript_path, exc
            )
            continue
        sources_by_hash[source.audio_hash] = source

    return TranscriptSourceBuild(
        workflow_group_id=workflow_group_id,
        backend_key=normalized_backend,
        run_id=run_id,
        transcripts_root=str(resolved_transcripts_root),
        transcript_files=len(transcript_paths),
        transcripts_skipped=skipped,
        sources=sorted(sources_by_hash.values(), key=lambda source: source.audio_hash),
    )


def build_chunks_for_transcript(
    *,
    transcript_path: Path,
    transcripts_root: Path,
    workflow_group_id: str,
    backend_key: str,
    run_id: str,
    min_chunk_tokens: int,
    max_chunk_tokens: int,
    overlap_tokens: int,
    chunk_tokenizer_model: str | None = None,
    token_counter=None,
) -> tuple[list[RagChunk], list[ChunkWindow]]:
    """Build canonical Besedy chunks for a single transcript file."""

    chunk_token_counter = token_counter or _get_chunk_token_counter(
        chunk_tokenizer_model=chunk_tokenizer_model,
    )

    data = load_json_with_fallback(transcript_path)
    if not isinstance(data, dict):
        raise ValueError(f"Invalid transcript JSON: {transcript_path}")

    components = parse_transcript_components(transcript_path, transcripts_root)
    if components is None:
        raise ValueError(f"Transcript path is outside transcripts root: {transcript_path}")

    workflow, model_component, hash_component = components
    file_backend = f"{workflow}/{model_component}"
    if file_backend != backend_key:
        raise ValueError(f"Transcript backend mismatch for {transcript_path}: {file_backend}")

    audio_hash = _infer_audio_hash(hash_component, data)
    if audio_hash is None:
        raise ValueError(f"Could not infer audio hash from transcript: {transcript_path}")

    segments = _segments_from_transcript(data, token_counter=chunk_token_counter)
    prepared_segments = split_segments_for_chunking(
        segments,
        token_counter=chunk_token_counter,
        max_segment_tokens=CHUNK_MAX_SEGMENT_TOKENS,
    )
    windows = chunk_segments(
        prepared_segments,
        token_counter=chunk_token_counter,
        min_tokens=min_chunk_tokens,
        max_tokens=max_chunk_tokens,
        overlap_tokens=overlap_tokens,
    )

    chunks: list[RagChunk] = []
    for chunk_ordinal, window in enumerate(windows):
        chunk_id = make_chunk_id(
            workflow_group_id=workflow_group_id,
            backend_key=backend_key,
            audio_hash=audio_hash,
            start_sec=window.start,
            end_sec=window.end,
        )
        chunks.append(
            RagChunk(
                chunk_id=chunk_id,
                chunk_version=CHUNK_VERSION,
                run_id=run_id,
                backend_key=backend_key,
                audio_hash=audio_hash,
                source_path=str(transcript_path),
                start=window.start,
                end=window.end,
                token_count=window.token_count,
                text=window.text,
                chunk_ordinal=chunk_ordinal,
            )
        )
    return chunks, windows


def build_chunk_corpus(
    *,
    workflow_group_id: str,
    backend_key: str,
    transcripts_root: Path | str | None = None,
    min_chunk_tokens: int = 220,
    max_chunk_tokens: int = 300,
    overlap_tokens: int = 50,
    chunk_tokenizer_model: str | None = None,
) -> ChunkCorpusBuild:
    """Build the canonical chunk corpus for one transcript backend scope."""

    normalized_backend = normalize_backend_key(backend_key)
    resolved_transcripts_root = resolve_transcripts_root(transcripts_root)
    if resolved_transcripts_root.is_symlink():
        resolved_transcripts_root = resolved_transcripts_root.resolve()
    run_id = require_run_id_from_transcripts_root(resolved_transcripts_root)
    transcript_paths = _discover_backend_transcripts(resolved_transcripts_root, normalized_backend)

    chunks_by_id: dict[str, RagChunk] = {}
    skipped = 0
    chunk_token_counter = _get_chunk_token_counter(
        chunk_tokenizer_model=chunk_tokenizer_model,
    )
    all_windows: list[ChunkWindow] = []
    transcript_paths_by_hash: dict[str, str] = {}

    for transcript_path in transcript_paths:
        try:
            transcript_chunks, windows = build_chunks_for_transcript(
                transcript_path=transcript_path,
                transcripts_root=resolved_transcripts_root,
                workflow_group_id=workflow_group_id,
                backend_key=normalized_backend,
                run_id=run_id,
                min_chunk_tokens=min_chunk_tokens,
                max_chunk_tokens=max_chunk_tokens,
                overlap_tokens=overlap_tokens,
                chunk_tokenizer_model=chunk_tokenizer_model,
                token_counter=chunk_token_counter,
            )
        except DuplicateTranscriptAudioHashError:
            raise
        except (ValueError, FileNotFoundError) as exc:
            skipped += 1
            LOGGER.debug(
                "Skipping transcript during chunk corpus build: %s (%s)", transcript_path, exc
            )
            continue

        if transcript_chunks:
            audio_hash = transcript_chunks[0].audio_hash
        else:
            audio_hash = build_transcript_source(
                transcript_path=transcript_path,
                transcripts_root=resolved_transcripts_root,
                backend_key=normalized_backend,
                chunk_tokenizer_model=chunk_tokenizer_model,
                token_counter=chunk_token_counter,
            ).audio_hash
        _register_unique_transcript_audio_hash(
            audio_hash=audio_hash,
            transcript_path=transcript_path,
            transcript_paths_by_hash=transcript_paths_by_hash,
        )
        all_windows.extend(windows)
        for chunk in transcript_chunks:
            chunks_by_id[chunk.chunk_id] = chunk

    chunks = sorted(chunks_by_id.values(), key=lambda chunk: chunk.chunk_id)
    chunk_distribution = summarize_chunk_windows(
        all_windows,
        token_counter=chunk_token_counter,
        min_tokens=min_chunk_tokens,
        max_tokens=max_chunk_tokens,
    )
    return ChunkCorpusBuild(
        workflow_group_id=workflow_group_id,
        backend_key=normalized_backend,
        run_id=run_id,
        transcripts_root=str(resolved_transcripts_root),
        transcript_files=len(transcript_paths),
        transcripts_skipped=skipped,
        chunk_version=CHUNK_VERSION,
        chunks=chunks,
        chunk_distribution=chunk_distribution,
    )


__all__ = [
    "ChunkCorpusBuild",
    "TranscriptSource",
    "TranscriptSourceBuild",
    "build_chunk_corpus",
    "build_chunks_for_transcript",
    "build_transcript_source",
    "discover_transcript_sources",
    "make_chunk_id",
    "slugify_backend_key",
    "slugify_model_name",
]
