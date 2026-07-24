"""Transcript JSON generation utilities for testing."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def create_minimal_transcript(
    text: str = "Hello world",
    start: float = 0.0,
    end: float = 2.0,
    confidence: float | None = None,
) -> dict[str, Any]:
    """Create a minimal valid transcript JSON structure.

    Args:
        text: Segment text.
        start: Start time in seconds.
        end: End time in seconds.
        confidence: Optional confidence score.

    Returns:
        Dict with "segments" list containing one segment.
    """
    segment: dict[str, Any] = {
        "start": start,
        "end": end,
        "text": text,
    }
    if confidence is not None:
        segment["confidence"] = confidence

    return {"segments": [segment]}


def create_transcript_with_words(
    words: list[str],
    start: float = 0.0,
    word_duration: float = 0.5,
    gap_duration: float = 0.1,
    confidence: float = 0.95,
) -> dict[str, Any]:
    """Create a transcript with word-level timing.

    Args:
        words: List of words.
        start: Start time of first word.
        word_duration: Duration of each word.
        gap_duration: Gap between words.
        confidence: Confidence score for words.

    Returns:
        Dict with segments containing word-level data.
    """
    word_entries = []
    current_time = start

    for word in words:
        word_end = current_time + word_duration
        word_entries.append(
            {
                "word": word,
                "start": round(current_time, 3),
                "end": round(word_end, 3),
                "confidence": confidence,
            }
        )
        current_time = word_end + gap_duration

    segment_end = current_time - gap_duration  # Remove last gap

    return {
        "segments": [
            {
                "start": start,
                "end": round(segment_end, 3),
                "text": " ".join(words),
                "confidence": confidence,
                "words": word_entries,
            }
        ]
    }


def create_multi_segment_transcript(
    segment_texts: list[str],
    segment_duration: float = 2.0,
    gap_duration: float = 0.5,
    start: float = 0.0,
) -> dict[str, Any]:
    """Create a transcript with multiple segments.

    Args:
        segment_texts: List of text for each segment.
        segment_duration: Duration of each segment.
        gap_duration: Gap between segments.
        start: Start time of first segment.

    Returns:
        Dict with multiple segments.
    """
    segments = []
    current_time = start

    for text in segment_texts:
        segment_end = current_time + segment_duration
        segments.append(
            {
                "start": round(current_time, 3),
                "end": round(segment_end, 3),
                "text": text,
            }
        )
        current_time = segment_end + gap_duration

    return {"segments": segments}


def create_diarization_json(
    speakers: list[str],
    segment_duration: float = 2.0,
    gap_duration: float = 0.5,
    start: float = 0.0,
) -> dict[str, Any]:
    """Create a diarization output JSON structure.

    Args:
        speakers: List of speaker labels (e.g., ["SPEAKER_00", "SPEAKER_01"]).
        segment_duration: Duration of each segment.
        gap_duration: Gap between segments.
        start: Start time.

    Returns:
        Dict with "segments" containing speaker diarization.
    """
    segments = []
    current_time = start

    for speaker in speakers:
        segment_end = current_time + segment_duration
        segments.append(
            {
                "start": round(current_time, 3),
                "end": round(segment_end, 3),
                "speaker": speaker,
            }
        )
        current_time = segment_end + gap_duration

    return {"segments": segments}


def write_transcript_json(
    path: Path,
    data: dict[str, Any],
    indent: int = 2,
) -> Path:
    """Write transcript data to a JSON file.

    Args:
        path: Output file path.
        data: Transcript data dict.
        indent: JSON indentation.

    Returns:
        Path to created file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=indent))
    return path


def create_transcript_directory_structure(
    root: Path,
    timestamp: str = "20251128_120000",
    backends: list[str] | None = None,
    audio_hash: str = "abc123def456",
) -> Path:
    """Create a complete transcript directory structure for testing.

    Args:
        root: Root directory.
        timestamp: Timestamp for directory name.
        backends: List of backend names (default: faster-whisper, canary-nemo).
        audio_hash: Audio file hash.

    Returns:
        Path to transcripts root directory.
    """
    if backends is None:
        backends = ["faster-whisper", "canary-nemo"]

    transcripts_root = root / f"transcripts_{timestamp}"

    for backend in backends:
        if backend == "faster-whisper":
            model = "large-v3@silero_vad_v6"
        elif backend == "canary-nemo":
            model = "nvidia_canary-1b-v2[greedy]@frame_vad"
        else:
            model = "default_model"

        transcript_dir = transcripts_root / backend / model / audio_hash
        transcript_dir.mkdir(parents=True)

        transcript_data = create_transcript_with_words(
            words=["Hello", "world", "test"],
            confidence=0.95,
        )
        write_transcript_json(transcript_dir / "transcript.json", transcript_data)

    return transcripts_root
