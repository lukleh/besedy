"""Canonical JSON loading utilities with encoding fallback.

IMPORTANT: This module provides THE canonical way to load JSON files in besedy.
Always use load_json_with_fallback() instead of json.load() or json.loads()
when reading transcript or diarization JSON files.

Why this exists:
    Legacy whisper.cpp CoreML outputs were written with ISO-8859-1 (latin-1)
    encoding instead of UTF-8. Naive json.load() fails with UnicodeDecodeError
    on these files. The load_json_with_fallback() function transparently handles
    this by first trying UTF-8, then falling back to latin-1 decoding.

Usage:
    from besedy.lib.data.encoding import load_json_with_fallback

    # Instead of:
    #   data = json.loads(path.read_text(encoding="utf-8"))  # BAD: may fail
    # Use:
    data = load_json_with_fallback(path)  # GOOD: handles encoding issues

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
    "load_json_with_encoding_info",
]


def load_json_with_fallback(path: Path) -> dict[str, Any]:
    """Load JSON file with encoding fallback for legacy outputs.

    Handles legacy whisper.cpp CoreML dumps where UTF-8 text was incorrectly
    written as latin-1 bytes. Recovers by re-encoding latin-1 back to bytes
    and decoding as UTF-8.

    Args:
        path: Path to JSON file.

    Returns:
        Parsed JSON data as dictionary.

    Raises:
        ValueError: If JSON is malformed or unreadable.
    """
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        # Legacy whisper.cpp files have UTF-8 bytes stored as latin-1 chars.
        # Re-encode to bytes, then decode as UTF-8 to recover the original text.
        text = path.read_text(encoding="latin-1")
        fixed_text = text.encode("latin-1").decode("utf-8", errors="ignore")
        return json.loads(fixed_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {path}: {exc}") from exc


def load_json_with_encoding_info(path: Path) -> tuple[dict[str, Any], str]:
    """Load JSON file, returning both data and encoding used.

    Args:
        path: Path to JSON file.

    Returns:
        Tuple of (data, encoding_used) where encoding is "utf-8" or "latin-1".

    Raises:
        json.JSONDecodeError: If JSON is malformed.
    """
    try:
        with path.open(encoding="utf-8") as handle:
            data = json.load(handle)
        return data, "utf-8"
    except UnicodeDecodeError:
        # Legacy whisper.cpp files have UTF-8 bytes stored as latin-1 chars.
        # Re-encode to bytes, then decode as UTF-8 to recover the original text.
        text = path.read_text(encoding="latin-1")
        fixed_text = text.encode("latin-1").decode("utf-8", errors="ignore")
        return json.loads(fixed_text), "latin-1"
