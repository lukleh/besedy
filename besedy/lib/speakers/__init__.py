"""Speaker clustering and embedding utilities.

This package contains modules extracted from cluster_speakers.py:
- utils: Small helpers and data loading
- cache: EmbeddingCache for caching extracted embeddings
- embeddings: Model loading and embedding computation (requires pyannote in the current runtime)
- matching: Speaker matching using hierarchical clustering

NOTE: Besedy runs speaker clustering through the Docker pyannote worker by
default. Direct host execution requires pyannote-audio in the current Python
environment.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

__all__ = [
    # utils
    "compute_segments_checksum",
    "load_diarization_json",
    "get_hf_token",
    # cache
    "EmbeddingCache",
    # embeddings (requires pyannote in the current runtime)
    "EmbeddingMap",
    "SpeakerId",
    "load_embedding_model",
    "pool_embeddings",
    "build_embedding_map",
    # matching
    "find_speaker_matches",
]

_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "compute_segments_checksum": ("besedy.lib.speakers.utils", "compute_segments_checksum"),
    "load_diarization_json": ("besedy.lib.speakers.utils", "load_diarization_json"),
    "get_hf_token": ("besedy.lib.speakers.utils", "get_hf_token"),
    "EmbeddingCache": ("besedy.lib.speakers.cache", "EmbeddingCache"),
    "EmbeddingMap": ("besedy.lib.speakers.embeddings", "EmbeddingMap"),
    "SpeakerId": ("besedy.lib.speakers.embeddings", "SpeakerId"),
    "load_embedding_model": ("besedy.lib.speakers.embeddings", "load_embedding_model"),
    "pool_embeddings": ("besedy.lib.speakers.embeddings", "pool_embeddings"),
    "build_embedding_map": ("besedy.lib.speakers.embeddings", "build_embedding_map"),
    "find_speaker_matches": ("besedy.lib.speakers.matching", "find_speaker_matches"),
}


def __getattr__(name: str) -> Any:
    try:
        module_name, attribute_name = _LAZY_IMPORTS[name]
    except KeyError as exc:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from exc

    module = import_module(module_name)
    value = getattr(module, attribute_name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(__all__) | set(globals()))
