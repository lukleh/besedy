"""Shared transcript discovery and loading helpers."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from besedy.core.paths import iter_transcript_paths, parse_transcript_components
from besedy.lib.data.encoding import load_json_with_fallback


def load_transcript_json(path: Path) -> dict | None:
    """Load a transcript JSON file, returning None on IO/parse errors.

    Uses encoding fallback to handle legacy transcript files with latin-1 encoding.
    """
    try:
        return load_json_with_fallback(path)
    except (FileNotFoundError, ValueError):
        return None


def find_transcripts_for_hash(
    hash_component: str,
    transcripts_root: Path,
    *,
    workflows: Sequence[str] | None = None,
) -> dict[str, Path]:
    """Locate transcript.json files for a hash prefix across workflows."""

    normalized = hash_component.strip().lower()
    if len(normalized) < 4:
        raise ValueError("hash_component must be at least 4 characters")

    workflows_filter = set(workflows or [])
    matches: dict[str, Path] = {}

    for path in iter_transcript_paths(transcripts_root):
        components = parse_transcript_components(path, transcripts_root)
        if components is None:
            continue
        workflow, model_component, audio_hash = components
        if workflows_filter and workflow not in workflows_filter:
            continue
        if audio_hash.startswith(normalized):
            model_key = f"{workflow}/{model_component}"
            matches[model_key] = path
    return matches


__all__ = [
    "load_transcript_json",
    "find_transcripts_for_hash",
]
