"""Diarization artifact lookup and fallback logging helpers."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from besedy.core.paths_common import (
    PYANNOTE_DIARIZATION_MODEL_NAME,
    PYANNOTE_DIARIZATION_WORKFLOW_LABEL,
)
from besedy.core.paths_runtime import (
    DIARIZATION_FALLBACK_LOG_PATH,
    LOGS_DIR,
    resolve_transcripts_root,
)
from besedy.core.paths_transcripts import sanitize_component


def log_diarization_event(entry: dict) -> None:
    """Append a diarization event to the shared JSONL log."""
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    entry_with_timestamp = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **entry,
    }
    with DIARIZATION_FALLBACK_LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry_with_timestamp) + "\n")


def find_speakers_json(
    base_dir: Path,
    hash_component: str,
) -> Path | None:
    """Locate speakers.json under base_dir, supporting hash prefixes."""
    sanitized = sanitize_component(hash_component)
    candidate = base_dir / sanitized / "speakers.json"
    if candidate.exists():
        return candidate
    if len(sanitized) >= 4:
        pattern = f"{sanitized}*/speakers.json"
        matches = sorted(base_dir.glob(pattern))
        if matches:
            return matches[0]
    return None


def preferred_diarization_speakers_path(
    hash_component: str,
    root: Path | str | None = None,
    *,
    primary: str = "pyannote",
    fallback: str | None = None,
    log_missing_primary: bool = False,
) -> tuple[Path | None, str | None]:
    """Resolve the preferred diarization speakers.json for a hash."""
    transcripts_root = resolve_transcripts_root(root)
    diarization_root = transcripts_root / PYANNOTE_DIARIZATION_WORKFLOW_LABEL

    def resolve_backend(backend: str) -> Path:
        match backend.lower():
            case "pyannote":
                model_name = PYANNOTE_DIARIZATION_MODEL_NAME
            case unsupported:
                raise ValueError(f"Unsupported diarization backend: {unsupported}")
        return diarization_root / model_name

    primary_dir = resolve_backend(primary)
    primary_path = find_speakers_json(primary_dir, hash_component)
    if primary_path:
        return primary_path, primary

    if fallback:
        fallback_dir = resolve_backend(fallback)
        fallback_path = find_speakers_json(fallback_dir, hash_component)
        if fallback_path:
            try:
                relative_path = str(fallback_path.relative_to(transcripts_root))
            except ValueError:
                relative_path = str(fallback_path)
            log_diarization_event(
                {
                    "event": "diarization_fallback",
                    "hash": sanitize_component(hash_component),
                    "preferred_backend": primary,
                    "used_backend": fallback,
                    "relative_path": relative_path,
                }
            )
            return fallback_path, fallback

    if log_missing_primary:
        log_diarization_event(
            {
                "event": "diarization_missing",
                "hash": sanitize_component(hash_component),
                "preferred_backend": primary,
            }
        )
    return None, None
