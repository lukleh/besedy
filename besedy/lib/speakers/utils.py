"""Small utility functions for speaker clustering.

This module contains helper functions for:
- Timestamp rounding for cache stability
- Segment key generation
- Checksum computation for cache invalidation
- Diarization JSON loading
- HuggingFace token retrieval
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

from besedy.lib.data.encoding import load_json_with_fallback


def round_time(value: float) -> float:
    """Round timestamps for stable cache comparisons.

    Args:
        value: Timestamp value.

    Returns:
        Timestamp rounded to 3 decimal places.
    """
    return round(float(value), 3)


def segment_key(speaker: str, start: float, end: float) -> tuple[str, float, float]:
    """Create a cache key for a diarization segment.

    Args:
        speaker: Speaker identifier.
        start: Segment start time.
        end: Segment end time.

    Returns:
        Tuple of (speaker, rounded_start, rounded_end).
    """
    return (
        speaker,
        round(float(start), 3),
        round(float(end), 3),
    )


def compute_segments_checksum(segments: list[dict]) -> str:
    """Create a stable checksum for the diarization segments.

    Used for cache invalidation when segment boundaries change.

    Args:
        segments: List of segment dictionaries with speaker, start, end.

    Returns:
        SHA-1 hex digest of normalized segments.
    """
    normalized = [
        {
            "speaker": seg.get("speaker"),
            "start": round(float(seg.get("start", 0.0)), 3),
            "end": round(float(seg.get("end", 0.0)), 3),
        }
        for seg in segments
    ]
    digest_input = json.dumps(normalized, sort_keys=True).encode("utf-8")
    return hashlib.sha1(digest_input).hexdigest()


def load_diarization_json(json_path: Path) -> dict:
    """Load speaker diarization results from JSON file.

    Uses encoding fallback to handle legacy outputs.

    Args:
        json_path: Path to the speakers.json file.

    Returns:
        Diarization data dictionary.

    Raises:
        ValueError: If required fields are missing or JSON is malformed.
    """
    data = load_json_with_fallback(json_path)

    # Validate required fields
    required_fields = ["audio_file", "segments"]
    for field in required_fields:
        if field not in data:
            raise ValueError(f"Missing required field '{field}' in {json_path}")

    return data


def get_hf_token() -> str:
    """Get HuggingFace token from environment.

    Checks HF_TOKEN and HUGGINGFACE_TOKEN environment variables first, then
    falls back to the cached Hugging Face login when available.

    Returns:
        HuggingFace token string.

    Note:
        Exits with error if no token is found.
    """
    hf_token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
    if not hf_token:
        try:
            from huggingface_hub import get_token

            hf_token = get_token()
        except Exception:
            hf_token = None
    if not hf_token:
        print("Error: No HF token found (env vars or cached Hugging Face login)")
        print("Please set HF_TOKEN/HUGGINGFACE_TOKEN or run 'hf auth login'")
        sys.exit(1)
    return hf_token
