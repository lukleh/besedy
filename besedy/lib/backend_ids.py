"""Backend identifiers.

This module is the single source of truth for canonical backend IDs used across Besedy.

Canonical identifiers:
- Workflow IDs (CLI + config): ``canary-nemo``, ``canary-nemo-beam``, ``faster-whisper``, ``whisperx``,
  ``qwen3-asr``, ``pyannote``
- Transcript JSON ``meta.backend`` (transcription only): uses the same IDs as workflow IDs.

Backward-compatibility note:
    This module is intentionally strict: it does *not* accept legacy aliases like
    ``nemo`` / ``nemo_vad`` / ``whisper_cpp``. Migrate older data instead.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BackendId:
    """Identifiers for a single backend."""

    workflow_id: str
    kind: str  # "transcription" | "diarization"
    meta_backend: str | None = None


_BACKENDS: tuple[BackendId, ...] = (
    BackendId(
        workflow_id="canary-nemo",
        kind="transcription",
        meta_backend="canary-nemo",
    ),
    BackendId(
        workflow_id="canary-nemo-beam",
        kind="transcription",
        meta_backend="canary-nemo-beam",
    ),
    BackendId(
        workflow_id="faster-whisper",
        kind="transcription",
        meta_backend="faster-whisper",
    ),
    BackendId(
        workflow_id="whisperx",
        kind="transcription",
        meta_backend="whisperx",
    ),
    BackendId(
        workflow_id="qwen3-asr",
        kind="transcription",
        meta_backend="qwen3-asr",
    ),
    BackendId(
        workflow_id="pyannote",
        kind="diarization",
    ),
)

WORKFLOW_IDS: tuple[str, ...] = tuple(b.workflow_id for b in _BACKENDS)
TRANSCRIPTION_WORKFLOW_IDS: tuple[str, ...] = tuple(
    b.workflow_id for b in _BACKENDS if b.kind == "transcription"
)
DIARIZATION_WORKFLOW_IDS: tuple[str, ...] = tuple(
    b.workflow_id for b in _BACKENDS if b.kind == "diarization"
)
TRANSCRIPT_META_BACKENDS = frozenset(
    b.meta_backend for b in _BACKENDS if b.kind == "transcription" and b.meta_backend
)

_META_BACKEND_BY_WORKFLOW_ID: dict[str, str] = {
    b.workflow_id: b.meta_backend for b in _BACKENDS if b.kind == "transcription" and b.meta_backend
}

_WORKFLOW_ID_BY_META_BACKEND: dict[str, str] = {
    meta_backend: workflow_id for workflow_id, meta_backend in _META_BACKEND_BY_WORKFLOW_ID.items()
}


def require_workflow_id(value: str) -> str:
    """Validate that ``value`` is a canonical workflow ID and return it."""

    if not isinstance(value, str):
        raise TypeError(f"backend identifier must be a string, got {type(value).__name__}")
    if value not in WORKFLOW_IDS:
        available = ", ".join(WORKFLOW_IDS)
        raise ValueError(f"Unknown backend identifier: {value!r}. Known backends: {available}")
    return value


def require_transcript_meta_backend(value: str) -> str:
    """Validate that ``value`` is a canonical transcript ``meta.backend`` value."""

    if not isinstance(value, str):
        raise TypeError(f"meta.backend must be a string, got {type(value).__name__}")
    if value not in TRANSCRIPT_META_BACKENDS:
        available = ", ".join(sorted(TRANSCRIPT_META_BACKENDS))
        raise ValueError(
            f"Unknown transcript meta.backend: {value!r}. Expected one of: {available}"
        )
    return value


def workflow_id_from_meta_backend(value: str) -> str:
    """Return the canonical workflow ID for a transcript ``meta.backend`` code."""

    return _WORKFLOW_ID_BY_META_BACKEND[require_transcript_meta_backend(value)]


__all__ = [
    "BackendId",
    "WORKFLOW_IDS",
    "TRANSCRIPTION_WORKFLOW_IDS",
    "DIARIZATION_WORKFLOW_IDS",
    "TRANSCRIPT_META_BACKENDS",
    "require_workflow_id",
    "require_transcript_meta_backend",
    "workflow_id_from_meta_backend",
]
