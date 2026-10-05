"""Reusable helpers for quick transcript validation."""

from __future__ import annotations

import time
from pathlib import Path

from besedy.lib.data.encoding import load_json_with_fallback
from besedy.lib.validation.schema import validate_canonical_schema
from besedy.lib.workflow.paths import get_transcript_backend_paths


def load_json(path: Path) -> dict | None:
    """Load a UTF-8 JSON file, returning None if it is missing or unreadable."""
    try:
        return load_json_with_fallback(path)
    except (ValueError, FileNotFoundError):
        return None


def find_recent_transcripts(root: Path, hours: int = 24) -> list[Path]:
    cutoff = time.time() - hours * 3600
    candidates: list[tuple[float, Path]] = []
    for path in root.rglob("transcript.json"):
        if not path.is_file():
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if mtime >= cutoff:
            candidates.append((mtime, path))
    candidates.sort(key=lambda item: item[0], reverse=True)
    return [path for _, path in candidates]


def get_sample_transcripts(root: Path, backends: list[str] | None = None) -> list[Path]:
    if backends is None:
        backends = list(get_transcript_backend_paths(root).values())
    samples: list[Path] = []
    for backend in backends:
        backend_dir = root / backend
        if not backend_dir.exists():
            continue
        for transcript in backend_dir.rglob("transcript.json"):
            samples.append(transcript)
            break
    return samples


def quick_validate(path: Path) -> tuple[bool, dict[str, object]]:
    data = load_json(path)
    if data is None:
        return False, {"error": "failed to load"}

    issues = validate_canonical_schema(data)
    meta = data.get("meta", {}) if isinstance(data.get("meta"), dict) else {}
    segments = data.get("segments", []) or []
    info = {
        "backend": meta.get("backend", "unknown"),
        "segments": len(segments),
        "words": sum(len(seg.get("words", [])) for seg in segments),
        "duration": meta.get("duration"),
        "issues": len(issues),
    }
    if issues:
        info["issue_samples"] = issues[:3]
    return len(issues) == 0, info


__all__ = [
    "find_recent_transcripts",
    "get_sample_transcripts",
    "quick_validate",
]
