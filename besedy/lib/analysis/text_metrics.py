"""Text and sentence-level metrics for transcripts.

Provides functions for analyzing text structure in transcripts:
- _sentence_stats_for_transcript: Analyze sentences, words per sentence, rate
"""

from __future__ import annotations

import re


def _sentence_stats_for_transcript(
    segments: list[dict], transcript_duration: float
) -> tuple[int, list[int], float]:
    """Analyze sentence structure in transcript segments.

    Sentences are detected by:
    1. Punctuation marks (.!?) in segment text
    2. Gaps > 1.0 second between segments

    Args:
        segments: List of segment dicts with 'start', 'end', 'text', 'words' keys
        transcript_duration: Total duration of transcript in seconds

    Returns:
        Tuple of (sentence_count, words_per_sentence_list, sentences_per_minute)
    """
    if not segments:
        return 0, [], 0.0

    sentences = 0
    words_per_sentence: list[int] = []
    current_words = 0
    prev_end = None

    for seg in sorted(segments, key=lambda s: s.get("start", 0.0)):
        start = float(seg.get("start") or 0.0)
        end = float(seg.get("end") or start)
        words = seg.get("words") or []
        text = seg.get("text") or ""

        if prev_end is not None and start - prev_end > 1.0:
            if current_words > 0:
                words_per_sentence.append(current_words)
            sentences += 1
            current_words = 0

        current_words += len(words)
        punct = len(re.findall(r"[.!?]", text))
        for _ in range(punct):
            sentences += 1
            words_per_sentence.append(current_words)
            current_words = 0

        prev_end = end

    if current_words > 0:
        sentences += 1
        words_per_sentence.append(current_words)

    spm = sentences / (transcript_duration / 60.0) if transcript_duration > 0 else 0.0
    return sentences, words_per_sentence, spm


__all__ = ["_sentence_stats_for_transcript"]
