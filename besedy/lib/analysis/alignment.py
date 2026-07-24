"""Word-level alignment helpers shared by CLI tools.

WHY word-level alignment: Different ASR models may segment audio differently,
but words provide the finest-grained comparison unit. Word-level alignment
reveals timing drift, systematic offsets, and content differences that
segment-level comparison would miss.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from besedy.lib.analysis.base import TimeSpanMixin


@dataclass(frozen=True)
class Word(TimeSpanMixin):
    start: float
    end: float
    text: str
    confidence: float | None


@dataclass
class PairMatchStats:
    matches: int
    unmatched_a: int
    unmatched_b: int
    start_diffs_abs: list[float]
    end_diffs_abs: list[float]
    start_diffs_signed: list[float]
    end_diffs_signed: list[float]
    text_matches: int
    total_pairs: int

    @property
    def coverage_a(self) -> float:
        total = self.matches + self.unmatched_a
        return self.matches / total if total else math.nan

    @property
    def coverage_b(self) -> float:
        total = self.matches + self.unmatched_b
        return self.matches / total if total else math.nan


def normalize_word(text: str) -> str:
    """Normalize word for text comparison.

    WHY this normalization: Different ASR models use different punctuation
    conventions (e.g., commas inside vs outside quotes). Stripping punctuation
    and lowercasing enables content comparison regardless of transcription style.
    """
    return text.lower().strip(".,!?\"'„():;[]{}<>…-–—")


def pairwise_match(
    words_a: Sequence[Word], words_b: Sequence[Word], tolerance: float
) -> PairMatchStats:
    """Match words between two transcripts based on timing proximity.

    This function aligns words from two different ASR transcripts by matching
    words whose start and end times are within a tolerance window. Uses a
    greedy sliding-window algorithm for O(n) performance.

    Algorithm:
        1. Maintain a sliding window index j into words_b
        2. For each word_a, advance j past words that end before word_a starts
        3. Check candidates at j-1, j, j+1 for best match (lowest timing error)
        4. Track matched indices to prevent duplicate matching

    Complexity:
        Time: O(n) where n = max(len(words_a), len(words_b))
        Space: O(n) for matched index set and diff lists

    WHY tolerance-based matching: ASR models have inherent timing variance.
    A 100ms (0.1s) default tolerance accounts for typical inter-model drift
    while avoiding false matches between adjacent words.

    WHY greedy matching: We use a greedy algorithm (first suitable candidate)
    rather than optimal bipartite matching for O(n) performance. The small
    loss in match quality is acceptable for diagnostic purposes.

    WHY track signed diffs: Signed differences reveal systematic timing bias
    (e.g., model A consistently starts words 50ms earlier than model B).
    Unsigned differences only show magnitude, not direction.

    Args:
        words_a: Sequence of Word objects from first transcript (sorted by time).
        words_b: Sequence of Word objects from second transcript (sorted by time).
        tolerance: Maximum time difference (in seconds) for start/end to match.

    Returns:
        PairMatchStats with match counts, unmatched counts, and timing
        difference distributions (both absolute and signed).
    """
    matched_b: set[int] = set()
    matches = 0
    unmatched_a = 0
    start_diffs_abs: list[float] = []
    end_diffs_abs: list[float] = []
    start_diffs_signed: list[float] = []
    end_diffs_signed: list[float] = []
    text_matches = 0

    # WHY sliding window with j: Words are sorted by time, so we can skip
    # words_b entries that are too early for the current word_a. This gives
    # O(n) instead of O(n²) complexity.
    j = 0
    for i, word_a in enumerate(words_a):
        while j < len(words_b) and words_b[j].start < word_a.start - tolerance:
            j += 1
        # WHY check j-1, j, j+1: Due to timing variance, the best match might
        # be slightly before or after our current position. Three candidates
        # handle edge cases without expanding to full neighborhood search.
        candidates = []
        for idx in (j - 1, j, j + 1):
            if 0 <= idx < len(words_b):
                candidates.append(idx)
        best_idx: int | None = None
        best_score = float("inf")
        for idx in candidates:
            if idx in matched_b:
                continue
            word_b = words_b[idx]
            start_diff = abs(word_a.start - word_b.start)
            end_diff = abs(word_a.end - word_b.end)
            if start_diff <= tolerance and end_diff <= tolerance:
                # WHY sum of diffs: Simple heuristic that prefers matches where
                # both start AND end times are close, not just one boundary
                score = start_diff + end_diff
                if score < best_score:
                    best_idx = idx
                    best_score = score
        if best_idx is None:
            unmatched_a += 1
            continue
        matched_b.add(best_idx)
        matches += 1
        word_b = words_b[best_idx]
        start_diff_signed = word_a.start - word_b.start
        end_diff_signed = word_a.end - word_b.end
        start_diffs_signed.append(start_diff_signed)
        end_diffs_signed.append(end_diff_signed)
        start_diffs_abs.append(abs(start_diff_signed))
        end_diffs_abs.append(abs(end_diff_signed))
        if normalize_word(word_a.text) == normalize_word(word_b.text):
            text_matches += 1

    unmatched_b = len(words_b) - len(matched_b)
    return PairMatchStats(
        matches=matches,
        unmatched_a=unmatched_a,
        unmatched_b=unmatched_b,
        start_diffs_abs=start_diffs_abs,
        end_diffs_abs=end_diffs_abs,
        start_diffs_signed=start_diffs_signed,
        end_diffs_signed=end_diffs_signed,
        text_matches=text_matches,
        total_pairs=matches,
    )


def analyse_word_overlap(words_a: Sequence[Word], words_b: Sequence[Word]) -> dict:
    """Compute temporal overlap between two word sequences.

    WHY overlap analysis: Unlike pairwise_match (which uses tolerance windows),
    this computes actual time intersection. High overlap with low pairwise
    match indicates timing drift; low overlap with high match indicates
    the models agree on word boundaries but differ in absolute timing.

    WHY two-pointer algorithm: O(n) sweep through both sorted word lists.
    We advance whichever word ends first, counting overlaps as we go.

    WHY multiplicity counts: A word that overlaps with 0 words from the other
    model indicates a gap; overlapping with multiple words indicates either
    a split or timing shift. These patterns help diagnose alignment quality.
    """
    counts_a = [0] * len(words_a)
    counts_b = [0] * len(words_b)
    overlap_duration = 0.0
    i = 0
    j = 0
    while i < len(words_a) and j < len(words_b):
        word_a = words_a[i]
        word_b = words_b[j]
        start = max(word_a.start, word_b.start)
        end = min(word_a.end, word_b.end)
        if start < end:
            overlap_duration += end - start
            counts_a[i] += 1
            counts_b[j] += 1
        # WHY advance the word that ends first: This ensures we don't skip
        # any potential overlaps. The word that ends later might still
        # overlap with subsequent words from the other sequence.
        if word_a.end <= word_b.end:
            i += 1
        else:
            j += 1
    return {"overlap_duration": overlap_duration, "counts_a": counts_a, "counts_b": counts_b}


__all__ = [
    "Word",
    "PairMatchStats",
    "normalize_word",
    "pairwise_match",
    "analyse_word_overlap",
]
