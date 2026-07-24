"""Utilities for measuring transcript coverage of diarized speaker segments."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from besedy.core.paths import preferred_diarization_speakers_path
from besedy.lib.data.encoding import load_json_with_fallback
from besedy.lib.data.lookup import find_transcripts_for_hash, load_transcript_json

from .speakers import SpeakerSegment
from .timeline import Segment, extract_segments


@dataclass
class SpeakerCoverageEntry:
    """Coverage stats for a single diarized speaker."""

    speaker: str
    duration: float
    covered_duration: float

    @property
    def coverage_percentage(self) -> float:
        return self.covered_duration / self.duration * 100.0 if self.duration > 0 else 0.0


@dataclass
class ModelCoverageResult:
    """Coverage summary for a single transcript model."""

    model_id: str
    covered_duration: float
    coverage_percentage: float
    speaker_entries: list[SpeakerCoverageEntry]


@dataclass
class SpeakerCoverageResult:
    """Overall coverage results for an audio hash."""

    audio_hash: str
    diarization_backend: str | None
    total_speakers: int
    total_speaker_duration: float
    models: dict[str, ModelCoverageResult]


def _load_diarization_segments(
    hash_component: str,
    transcripts_root: Path,
) -> tuple[list[SpeakerSegment], str | None]:
    """Load diarization segments, preferring Pyannote with fallback."""

    speakers_path, backend = preferred_diarization_speakers_path(
        hash_component,
        root=transcripts_root,
        primary="pyannote",
        fallback=None,
    )

    if not speakers_path or not speakers_path.exists():
        return [], None

    try:
        data = load_json_with_fallback(speakers_path)
    except ValueError:
        return [], backend

    segments: list[SpeakerSegment] = []
    for raw in data.get("segments", []) or []:
        try:
            start = float(raw.get("start", 0.0))
            end = float(raw.get("end", 0.0))
        except (TypeError, ValueError):
            continue
        speaker = str(raw.get("speaker", "")).strip()
        if not speaker or end <= start:
            continue
        segments.append(SpeakerSegment(start=start, end=end, speaker=speaker))

    return segments, backend


def _merge_intervals(intervals: Iterable[tuple[float, float]]) -> list[tuple[float, float]]:
    """Merge overlapping [start, end] tuples into a sorted union."""

    cleaned = [(float(start), float(end)) for start, end in intervals if end > start]
    if not cleaned:
        return []

    cleaned.sort(key=lambda item: item[0])
    merged: list[tuple[float, float]] = []
    cur_start, cur_end = cleaned[0]
    for start, end in cleaned[1:]:
        if start <= cur_end + 1e-6:
            cur_end = max(cur_end, end)
        else:
            merged.append((cur_start, cur_end))
            cur_start, cur_end = start, end
    merged.append((cur_start, cur_end))
    return merged


def _interval_overlap(
    segment_start: float,
    segment_end: float,
    coverage_intervals: Sequence[tuple[float, float]],
) -> float:
    """Return overlap length between a segment and merged coverage intervals."""

    if not coverage_intervals:
        return 0.0

    covered = 0.0
    for start, end in coverage_intervals:
        if end <= segment_start:
            continue
        if start >= segment_end:
            break
        overlap = min(end, segment_end) - max(start, segment_start)
        if overlap > 0:
            covered += overlap
    return covered


def _load_transcript_segments(path: Path, source_id: str) -> list[Segment]:
    data = load_transcript_json(path)
    if not data:
        return []
    return extract_segments(data, source_id)


def analyze_speaker_coverage(
    hash_component: str,
    transcripts_root: Path,
    *,
    workflows: Sequence[str] | None = None,
) -> SpeakerCoverageResult | None:
    """Compute transcript coverage of diarized speaker segments for a hash."""

    diarization_segments, backend = _load_diarization_segments(hash_component, transcripts_root)
    if not diarization_segments:
        return None

    transcripts = find_transcripts_for_hash(
        hash_component,
        transcripts_root,
        workflows=workflows,
    )
    if not transcripts:
        return None

    total_speaker_duration = sum(seg.duration for seg in diarization_segments)
    if total_speaker_duration <= 0:
        return None

    speaker_durations: dict[str, float] = {}
    for seg in diarization_segments:
        speaker_durations[seg.speaker] = speaker_durations.get(seg.speaker, 0.0) + seg.duration

    model_results: dict[str, ModelCoverageResult] = {}

    for model_id, path in transcripts.items():
        segments = _load_transcript_segments(path, model_id)
        if not segments:
            continue
        intervals = _merge_intervals((seg.start, seg.end) for seg in segments)
        if not intervals:
            continue

        per_speaker: dict[str, dict[str, float]] = {
            speaker: {"duration": duration, "covered": 0.0}
            for speaker, duration in speaker_durations.items()
        }
        covered_total = 0.0

        for seg in diarization_segments:
            overlap = _interval_overlap(seg.start, seg.end, intervals)
            if overlap <= 0:
                continue
            covered_total += overlap
            per_speaker[seg.speaker]["covered"] += overlap

        entries = [
            SpeakerCoverageEntry(
                speaker=speaker,
                duration=stats["duration"],
                covered_duration=stats["covered"],
            )
            for speaker, stats in sorted(per_speaker.items())
        ]

        coverage_pct = covered_total / total_speaker_duration * 100.0
        model_results[model_id] = ModelCoverageResult(
            model_id=model_id,
            covered_duration=covered_total,
            coverage_percentage=coverage_pct,
            speaker_entries=entries,
        )

    if not model_results:
        return None

    return SpeakerCoverageResult(
        audio_hash=hash_component,
        diarization_backend=backend,
        total_speakers=len(speaker_durations),
        total_speaker_duration=total_speaker_duration,
        models=model_results,
    )


__all__ = [
    "SpeakerCoverageEntry",
    "ModelCoverageResult",
    "SpeakerCoverageResult",
    "analyze_speaker_coverage",
]
