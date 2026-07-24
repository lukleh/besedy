"""Speaker diarization analysis: overlap and agreement metrics."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SpeakerSegment:
    """Single speaker segment from diarization."""

    start: float
    end: float
    speaker: str

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass
class DiarizationData:
    """Diarization output from a single backend."""

    audio_file: str
    model: str
    num_speakers: int
    segments: list[SpeakerSegment]

    @property
    def total_duration(self) -> float:
        return sum(seg.duration for seg in self.segments)

    def get_speaker_durations(self) -> dict[str, float]:
        """Return mapping of speaker ID to total speaking time."""
        durations = {}
        for seg in self.segments:
            durations[seg.speaker] = durations.get(seg.speaker, 0.0) + seg.duration
        return durations


@dataclass
class OverlapAnalysis:
    """Analysis of segment overlap between two diarizations."""

    total_overlap_duration: float
    total_conflict_duration: float  # Same time, different speaker
    agreement_ratio: float  # 0.0 to 1.0


def compute_overlap(
    diarization_a: DiarizationData,
    diarization_b: DiarizationData,
) -> OverlapAnalysis:
    """Compute overlap and agreement statistics between two diarizations.

    WARNING: This function has INCOMPLETE speaker ID mapping logic.
    The agreement_ratio and total_conflict_duration metrics are currently
    PLACEHOLDERS and should not be used for production analysis. See the
    implementation TODO comments for what needs to be completed.

    Current Behavior:
        - total_overlap_duration: Correctly computed (any speech overlap)
        - total_conflict_duration: Always 0.0 (speaker mapping not implemented)
        - agreement_ratio: Always 1.0 (based on zero conflict)

    What's Missing:
        Speaker ID mapping between diarizations (e.g., one's SPEAKER_01 may be
        the other's SPEAKER_02). Proper implementation requires Hungarian
        algorithm or similar optimal assignment based on overlap durations.

    Algorithm (current, incomplete):
        1. Sort segments from both diarizations by start time
        2. For each segment in A, check all segments in B for overlap
        3. Compute overlap duration as min(end1, end2) - max(start1, start2)
        4. Skip conflict detection (not implemented)
        5. Return overlap metrics (agreement metrics are placeholders)

    Complexity:
        Time: O(n * m) where n = segments in A, m = segments in B
        Space: O(1) aside from input

    Args:
        diarization_a: DiarizationData from first diarization.
        diarization_b: DiarizationData from second diarization.

    Returns:
        OverlapAnalysis with total_overlap_duration (accurate) and
        placeholder values for conflict/agreement metrics.

    Note:
        - This O(n*m) approach could be optimized with interval trees
        - Different speaker counts between diarizations are logged but not handled
    """
    # Sort segments by start time
    segs_a = sorted(diarization_a.segments, key=lambda s: s.start)
    segs_b = sorted(diarization_b.segments, key=lambda s: s.start)

    total_overlap = 0.0
    total_conflict = 0.0

    # For each segment in A, find overlapping segments in B
    for seg_a in segs_a:
        for seg_b in segs_b:
            # Check if segments overlap
            overlap_start = max(seg_a.start, seg_b.start)
            overlap_end = min(seg_a.end, seg_b.end)

            if overlap_start < overlap_end:
                overlap_duration = overlap_end - overlap_start
                total_overlap += overlap_duration

                # If speakers don't match (accounting for different numbering),
                # this is a potential conflict. For simplicity, we count all overlaps
                # as conflicts if the models disagree on speaker count.
                if diarization_a.num_speakers != diarization_b.num_speakers:
                    # Different speaker counts means we can't directly compare IDs
                    # This is a known limitation that requires more sophisticated mapping
                    pass

    # Agreement ratio: how much of the audio is covered consistently
    max_duration = max(diarization_a.total_duration, diarization_b.total_duration)
    agreement_ratio = (max_duration - total_conflict) / max_duration if max_duration > 0 else 1.0

    return OverlapAnalysis(
        total_overlap_duration=total_overlap,
        total_conflict_duration=total_conflict,
        agreement_ratio=agreement_ratio,
    )
