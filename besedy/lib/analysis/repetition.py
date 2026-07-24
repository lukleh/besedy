"""Repetition detection in transcripts.

This module provides functions to detect repeated sequences at character,
word, and segment levels.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

_EDGE_PUNCT_RE = re.compile(r"^\W+|\W+$", re.UNICODE)
_WHITESPACE_RE = re.compile(r"\s+")


@dataclass
class RepeatFinding:
    """A detected repetition in a transcript."""

    kind: str  # "chars", "words", or "segments"
    length: int  # Length of repeated unit
    repeats: int  # Number of repetitions
    start_index: int  # Starting index (char/word/segment)
    snippet: str  # Context snippet
    sequence: str  # The repeated sequence
    char_start: int
    char_end: int
    segment_start: int | None
    segment_end: int | None
    start_time: float | None
    end_time: float | None
    boundary: bool = False  # Whether this is a boundary repeat


def _normalize_token(token: str) -> str:
    """Normalize token for repetition matching.

    Keeps diacritics, but folds case and strips edge punctuation so
    `Hello`, `hello`, and `hello,` match as the same token.
    """
    normalized = unicodedata.normalize("NFKC", token).casefold()
    return _EDGE_PUNCT_RE.sub("", normalized)


def _normalize_segment_text(text: str) -> str:
    """Normalize full segment text for matching repeated segments."""
    if not text:
        return ""

    normalized = unicodedata.normalize("NFKC", text).casefold().strip()
    if not normalized:
        return ""

    normalized_tokens: list[str] = []
    for token in _WHITESPACE_RE.split(normalized):
        stripped = _EDGE_PUNCT_RE.sub("", token)
        if stripped:
            normalized_tokens.append(stripped)
    return " ".join(normalized_tokens)


def _sliding_repeats(
    sequence: Sequence[str], unit_size: int, min_repeats: int
) -> Iterable[tuple[int, int]]:
    """Yield (start_index, repeat_count) for repeated blocks of size unit_size.

    This function detects consecutive repetitions of fixed-size blocks in a sequence.
    Used to find ASR repetition errors like "the the the" or "going going going".

    Algorithm:
        1. Slide a window of unit_size across the sequence
        2. For each position, extract the block and check subsequent positions
        3. Greedily extend while consecutive blocks match
        4. If repeat_count >= min_repeats, yield and skip to end of repetition
        5. Otherwise advance by 1 and continue

    Complexity:
        Time: O(n * m) where n = len(sequence), m = unit_size
        Space: O(m) for block comparison

    WHY sliding window: We need to detect consecutive repetitions of arbitrary-length
    patterns. A sliding window is O(n*m) where m is unit_size, which is acceptable
    for transcript lengths. Suffix trees would be faster but add complexity.

    WHY greedy extension: When we find a repeat, we extend as far as possible before
    yielding. This prevents reporting nested/overlapping repetitions (e.g., "ab ab ab"
    would only report 3 repeats of "ab", not also 2 repeats starting at position 1).

    Args:
        sequence: Input sequence (list of strings, typically words or characters).
        unit_size: Size of the repeated unit to detect.
        min_repeats: Minimum number of consecutive repetitions to report.

    Yields:
        Tuples of (start_index, repeat_count) for each detected repetition.

    Note:
        - Returns nothing if unit_size <= 0 or min_repeats <= 1
        - Reported repetitions are non-overlapping (greedy maximal)
    """
    if unit_size <= 0 or min_repeats <= 1:
        return

    n = len(sequence)
    limit = unit_size * min_repeats
    if n < limit:
        return

    idx = 0
    while idx <= n - limit:
        block = sequence[idx : idx + unit_size]
        if not block:
            idx += 1
            continue

        repeat_count = 1
        probe = idx + unit_size
        while probe + unit_size <= n and sequence[probe : probe + unit_size] == block:
            repeat_count += 1
            probe += unit_size

        if repeat_count >= min_repeats:
            yield idx, repeat_count
            # WHY skip to probe: Greedy - report the maximal repetition, don't
            # re-examine positions within it (they'd give shorter/subset findings)
            idx = probe
        else:
            idx += 1


def find_character_repeats(
    text: str,
    min_len: int = 2,
    max_len: int = 32,
    min_repeats: int = 2,
) -> list[RepeatFinding]:
    """Find repeated character sequences.

    WHY min_len=2: Single-character repeats (e.g., "aaa") are too common and
    usually intentional (ellipsis, emphasis). Two-char minimum catches real
    stutters like "abab" while reducing noise.

    WHY max_len=32: Balances coverage vs computation. Longer patterns are rare
    in real transcription errors (ASR typically loops on shorter units). Beyond
    32 chars, false positives from coincidental text increase.
    """
    findings: list[RepeatFinding] = []

    for window in range(min_len, max_len + 1):
        for start, count in _sliding_repeats(text, window, min_repeats):
            chunk = text[start : start + window]
            # WHY skip whitespace: Repeated spaces/newlines are formatting,
            # not transcription errors worth flagging
            if not chunk.strip():
                continue

            span_len = window * count
            context_start = max(0, start - 40)
            context_end = min(len(text), start + span_len + 40)
            snippet = "…" + text[context_start:context_end].replace("\n", " ") + "…"

            findings.append(
                RepeatFinding(
                    kind="chars",
                    length=window,
                    repeats=count,
                    start_index=start,
                    snippet=snippet,
                    sequence=chunk,
                    char_start=start,
                    char_end=start + span_len,
                    segment_start=None,
                    segment_end=None,
                    start_time=None,
                    end_time=None,
                )
            )

    # WHY this sort order: Prioritize by total impact (length * repeats) so the most
    # significant repetitions appear first. Secondary sort by repeats (more is worse),
    # then by length (longer patterns are more suspicious) for tie-breaking.
    findings.sort(key=lambda f: (f.length * f.repeats, f.repeats, f.length), reverse=True)
    return findings


def find_word_repeats(
    text: str,
    min_len: int = 1,
    max_len: int = 8,
    min_repeats: int = 2,
) -> list[RepeatFinding]:
    """Find repeated word sequences.

    WHY min_len=1: Single-word repeats ("the the", "and and") are common ASR
    stuttering artifacts. Unlike characters, single-word repeats are almost
    always errors worth catching.

    WHY max_len=8: Eight-word phrases cover most sentence-level loops while
    staying computationally reasonable. Beyond 8 words, you're matching entire
    paragraphs which are rare errors and expensive to detect.
    """
    # Tokenize into words
    words = []
    word_positions = []
    start = 0
    length = len(text)

    while start < length:
        if text[start].isspace():
            start += 1
            continue
        end = start + 1
        while end < length and not text[end].isspace():
            end += 1
        words.append(text[start:end])
        word_positions.append((start, end))
        start = end

    normalized_words = [_normalize_token(word) for word in words]

    findings: list[RepeatFinding] = []

    for window in range(min_len, max_len + 1):
        for start_idx, count in _sliding_repeats(normalized_words, window, min_repeats):
            chunk_tokens = words[start_idx : start_idx + window]
            chunk_normalized = normalized_words[start_idx : start_idx + window]

            # Ignore patterns that include punctuation-only tokens after normalization.
            if any(not token for token in chunk_normalized):
                continue

            # WHY skip punctuation-only repeats: Repeated punctuation like "..." "..."
            # is often intentional (ellipsis, hesitation markers). Only flag if the
            # repeated "word" contains actual alphanumeric content.
            if (
                all(token == chunk_normalized[0] for token in chunk_normalized)
                and len(chunk_normalized) == 1
            ):
                if not any(c.isalnum() for c in chunk_tokens[0]):
                    continue

            # WHY 5-word context: Provides enough surrounding text to understand the
            # repetition in context without overwhelming the output with long snippets
            snippet_tokens = words[max(0, start_idx - 5) : start_idx + window * count + 5]
            snippet = "…" + " ".join(snippet_tokens) + "…"

            char_start = word_positions[start_idx][0]
            char_end = word_positions[start_idx + window * count - 1][1]

            findings.append(
                RepeatFinding(
                    kind="words",
                    length=window,
                    repeats=count,
                    start_index=start_idx,
                    snippet=snippet,
                    sequence=" ".join(chunk_tokens),
                    char_start=char_start,
                    char_end=char_end,
                    segment_start=None,
                    segment_end=None,
                    start_time=None,
                    end_time=None,
                )
            )

    findings.sort(key=lambda f: (f.length * f.repeats, f.repeats, f.length), reverse=True)
    return findings


def find_segment_repeats(
    segments: list[dict[str, Any]],
    min_repeats: int = 2,
) -> list[RepeatFinding]:
    """Find repeated segment sequences.

    WHY segment-level detection: ASR models sometimes loop entire utterances,
    producing duplicate segments with identical text but different timestamps.
    This is distinct from word/char repeats and indicates a different failure mode.
    """
    valid_segments = [seg for seg in segments if isinstance(seg, dict)]
    if not valid_segments or len(valid_segments) < min_repeats:
        return []

    segments = valid_segments
    segment_texts = [str(seg.get("text", "")).strip() for seg in segments]
    normalized_segment_texts = [_normalize_segment_text(text) for text in segment_texts]
    findings: list[RepeatFinding] = []

    # WHY max window of 16: Beyond 16 segments, you're matching multi-minute chunks
    # which are virtually never ASR artifacts. Also keeps computation bounded for
    # transcripts with thousands of segments.
    for window in range(1, min(len(segments), 16) + 1):
        for start, count in _sliding_repeats(normalized_segment_texts, window, min_repeats):
            block = segments[start : start + window]
            # WHY skip empty segments: Empty-text repetitions are meaningless and
            # would generate false positives from silence/pause segments
            normalized_block = normalized_segment_texts[start : start + window]
            if not all(normalized_block):
                continue

            seg_start = block[0]
            seg_end = segments[start + window * count - 1]

            snippet = (
                "…"
                + " / ".join(segment_texts[max(0, start - 2) : start + window * count + 2])
                + "…"
            )
            sequence = " | ".join(seg.get("text", "") for seg in block)

            findings.append(
                RepeatFinding(
                    kind="segments",
                    length=window,
                    repeats=count,
                    start_index=start,
                    snippet=snippet,
                    sequence=sequence,
                    char_start=0,
                    char_end=0,
                    segment_start=start,
                    segment_end=start + window * count - 1,
                    start_time=seg_start.get("start"),
                    end_time=seg_end.get("end"),
                )
            )

    findings.sort(key=lambda f: (f.length * f.repeats, f.repeats, f.length), reverse=True)
    return findings


def detect_all_repetitions(
    data: dict[str, Any],
    char_min: int = 2,
    char_max: int = 32,
    word_min: int = 1,
    word_max: int = 8,
    min_repeats: int = 2,
) -> dict[str, list[RepeatFinding]]:
    """Detect all types of repetitions in a transcript.

    Returns:
        Dictionary with keys 'chars', 'words', 'segments' containing findings.
    """
    # Extract text
    raw_segments = data.get("segments", [])
    segments = (
        [seg for seg in raw_segments if isinstance(seg, dict)]
        if isinstance(raw_segments, list)
        else []
    )
    segment_texts = [str(seg.get("text", "")) for seg in segments]
    full_text = "\n".join(segment_texts)

    results = {
        "chars": find_character_repeats(full_text, char_min, char_max, min_repeats),
        "words": find_word_repeats(full_text, word_min, word_max, min_repeats),
        "segments": find_segment_repeats(segments, min_repeats),
    }

    return results
