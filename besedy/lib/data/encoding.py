"""Canonical JSON loading for transcript and diarization files.

IMPORTANT: This module provides THE canonical way to load JSON files in besedy.
Always use load_json_with_fallback() instead of json.load() or json.loads()
when reading transcript or diarization JSON files.

Why this exists:
    Transcript JSON must be UTF-8. load_json_with_fallback() reads it strictly
    and turns both undecodable bytes and malformed JSON into a ValueError that
    names the file, so callers handle one exception type and never get silently
    altered text. The name is historical: it once fell back to latin-1, which
    dropped every byte that was not valid UTF-8.

Usage:
    from besedy.lib.data.encoding import load_json_with_fallback

    # Instead of:
    #   data = json.loads(path.read_text(encoding="utf-8"))  # BAD: raw errors
    # Use:
    data = load_json_with_fallback(path)  # GOOD: ValueError naming the file

When returning None on failure (e.g., for optional files):
    try:
        data = load_json_with_fallback(path)
    except (ValueError, FileNotFoundError):
        data = None

For higher-level transcript loading:
    from besedy.lib.data.lookup import load_transcript_json
    data = load_transcript_json(path)  # Returns None on any error
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

__all__ = [
    "load_json_with_fallback",
]


def load_json_with_fallback(path: Path) -> dict[str, Any]:
    """Load a UTF-8 JSON file.

    Args:
        path: Path to JSON file.

    Returns:
        Parsed JSON data as dictionary.

    Raises:
        ValueError: If the file is not valid UTF-8 or the JSON is malformed.
    """
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError as exc:
        raise ValueError(
            f"{path} is not valid UTF-8 (byte offset {exc.start}): {exc.reason}"
        ) from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {path}: {exc}") from exc
