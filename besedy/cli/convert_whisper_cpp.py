#!/usr/bin/env python3
"""Convert whisper.cpp transcript exports into the canonical alignment schema.

Assumptions:
    - Input tokens mirror whisper.cpp BPE output order, including special markers ``[_XYZ_]``.
    - Legacy CoreML dumps may use latin-1 encoding for ``transcript_original.json``.
    - Token offsets are VAD-compressed (silence removed); segment offsets are absolute.
      We shift token times by the segment start instead of scaling to the segment window.
    - Canonical transcripts expect per-word timestamps with normalized boundaries.

Usage:
    # Single file (auto-outputs transcript.json alongside source):
    uv run python besedy/cli/convert_whisper_cpp.py transcripts/whisper.cpp/.../transcript_original.json --catalog catalog.csv

    # Directory (automatic recursive conversion):
    uv run python besedy/cli/convert_whisper_cpp.py transcripts/whisper.cpp --catalog catalog.csv

    # Force re-conversion of already-converted files:
    uv run python besedy/cli/convert_whisper_cpp.py transcripts/whisper.cpp --catalog catalog.csv --force

By default, files are skipped if transcript.json already exists. Use --force to re-convert.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import traceback
from collections.abc import Iterable
from pathlib import Path
from typing import Any, TypedDict, cast

from besedy.core.paths import (
    extract_timestamp_from_transcripts_root,
    resolve_project_path,
)
from besedy.lib.audio.probe import measure_audio_duration_seconds


class WhisperCppConversionError(Exception):
    """Raised when whisper.cpp data cannot be converted reliably."""


WHISPER_CPP_DIRNAME = "whisper.cpp"
TIMESTAMP_PRECISION = 6
DEBUG_PREVIEW_BYTES = 100
DEBUG_PREVIEW_CHARS = 100
TIMESTAMP_EPS = 1e-6


class TokenDict(TypedDict, total=False):
    text: str
    offsets: dict[str, int | None]
    timestamps: dict[str, str | None]
    id: int | None
    p: float | None


class SegmentDict(TypedDict, total=False):
    offsets: dict[str, int | None]
    text: str
    tokens: list[TokenDict]


class PayloadDict(TypedDict, total=False):
    transcription: list[SegmentDict]
    params: dict[str, Any]
    model: dict[str, Any]
    result: dict[str, Any]
    systeminfo: dict[str, Any]


def _is_special_token(text: str) -> bool:
    """Return True if the token text represents a special whisper.cpp marker."""

    return text.startswith("[_") and text.endswith("]")


def _decode_segment_text(raw_text: str, source_encoding: str) -> str:
    """Decode a raw whisper.cpp segment string into proper UTF-8 text."""

    if source_encoding != "latin-1":
        return raw_text
    try:
        segment_text_bytes = raw_text.encode("latin-1")
        return segment_text_bytes.decode("utf-8")
    except Exception as exc:  # pragma: no cover - defensive
        raise WhisperCppConversionError(f"Failed to decode segment bytes as UTF-8: {exc}")


def _encode_ground_truth_bytes(segment_text: str, source_encoding: str) -> tuple[str, bytes]:
    """Return the canonical text plus the byte sequence used for validation."""
    if source_encoding == "latin-1":
        try:
            ground_truth_bytes = segment_text.encode("latin-1")
        except Exception as exc:
            raise WhisperCppConversionError(f"Failed to encode segment text as latin-1: {exc}")
        try:
            correct_text = ground_truth_bytes.decode("utf-8")
        except Exception as exc:
            raise WhisperCppConversionError(f"Failed to decode segment bytes as UTF-8: {exc}")
        return correct_text, ground_truth_bytes
    correct_text = segment_text
    return correct_text, segment_text.encode("utf-8")


def _merge_broken_utf8_tokens(
    tokens: list[TokenDict],
    segment_text: str,
    source_encoding: str = "latin-1",
    debug: bool = False,
) -> list[TokenDict]:
    """Merge tokens by matching them to ground truth UTF-8 byte boundaries."""

    if not tokens:
        return []

    correct_text, ground_truth_bytes = _encode_ground_truth_bytes(segment_text, source_encoding)

    if debug:
        print("\n=== DEBUG: Token Merging ===")
        print(f"Segment text (mojibake): {segment_text[:DEBUG_PREVIEW_CHARS]}")
        print(f"Correct text: {correct_text[:DEBUG_PREVIEW_CHARS]}")
        print(
            f"Ground truth bytes ({len(ground_truth_bytes)}): {ground_truth_bytes[:DEBUG_PREVIEW_BYTES]}"
        )

    # Phase 2: map characters to byte ranges
    char_byte_map: list[dict[str, Any]] = []
    byte_pos = 0
    for char in correct_text:
        char_bytes = char.encode("utf-8")
        char_byte_map.append(
            {
                "char": char,
                "byte_start": byte_pos,
                "byte_end": byte_pos + len(char_bytes),
                "bytes": char_bytes,
            }
        )
        byte_pos += len(char_bytes)

    if debug:
        print(f"\nCharacter map ({len(char_byte_map)} chars):")
        for i, cm in enumerate(char_byte_map[:10]):
            print(
                f"  [{i}] '{cm['char']}' bytes[{cm['byte_start']}:{cm['byte_end']}] = {cm['bytes']}"
            )
        if len(char_byte_map) > 10:
            print(f"  ... and {len(char_byte_map) - 10} more")

    # Phase 3: map tokens to byte ranges (skip specials)
    token_byte_map = []
    byte_pos = 0
    for idx, token in enumerate(tokens):
        token_text = token.get("text", "")
        if _is_special_token(token_text):
            if debug:
                print(f"Token[{idx}]: SPECIAL {token_text} - skipped")
            continue
        if source_encoding == "latin-1":
            token_bytes = token_text.encode("latin-1") if token_text else b""
        else:
            token_bytes = token_text.encode("utf-8", errors="replace")
        token_byte_map.append(
            {
                "token": token,
                "token_idx": idx,
                "byte_start": byte_pos,
                "byte_end": byte_pos + len(token_bytes),
                "bytes": token_bytes,
            }
        )
        byte_pos += len(token_bytes)

    total_token_bytes = byte_pos
    if total_token_bytes != len(ground_truth_bytes):
        raise WhisperCppConversionError(
            "Token bytes length ({}) doesn't match ground truth ({})\nGround truth: {}\n"
            "This indicates the token stream doesn't match the segment text.".format(
                total_token_bytes,
                len(ground_truth_bytes),
                ground_truth_bytes[:DEBUG_PREVIEW_BYTES],
            )
        )

    reconstructed_bytes = b"".join(tm["bytes"] for tm in token_byte_map)
    if reconstructed_bytes != ground_truth_bytes:
        raise WhisperCppConversionError(
            "Token bytes don't match ground truth bytes!\nExpected: {}\nGot: {}\n"
            "This indicates data corruption or encoding mismatch.".format(
                ground_truth_bytes[:DEBUG_PREVIEW_BYTES],
                reconstructed_bytes[:DEBUG_PREVIEW_BYTES],
            )
        )

    merged_tokens: list[TokenDict] = []
    token_idx = 0

    char_idx = 0
    while char_idx < len(char_byte_map):
        char_info = char_byte_map[char_idx]
        char_start = char_info["byte_start"]
        char_end = char_info["byte_end"]
        tokens_for_char = []
        scan_idx = token_idx
        while scan_idx < len(token_byte_map):
            token_info = token_byte_map[scan_idx]
            token_start = token_info["byte_start"]
            token_end = token_info["byte_end"]
            if token_end <= char_start:
                scan_idx += 1
                continue
            if token_start >= char_end:
                break
            tokens_for_char.append(token_info)
            if token_end >= char_end:
                token_idx = scan_idx if token_end > char_end else scan_idx + 1
                break
            scan_idx += 1
        if not tokens_for_char:
            raise WhisperCppConversionError(
                "Character '{}' at bytes[{}:{}] has no tokens.".format(
                    char_info["char"], char_start, char_end
                )
            )
        first_token = tokens_for_char[0]["token"]
        last_token = tokens_for_char[-1]["token"]
        first_offsets = first_token.get("offsets", {})
        last_offsets = last_token.get("offsets", {})
        confidences = [
            t["token"].get("p") for t in tokens_for_char if t["token"].get("p") is not None
        ]
        avg_confidence = sum(confidences) / len(confidences) if confidences else None
        merged_tokens.append(
            {
                "text": char_info["char"],
                "offsets": {
                    "from": first_offsets.get("from"),
                    "to": last_offsets.get("to"),
                },
                "p": avg_confidence,
            }
        )
        if debug and len(tokens_for_char) > 1:
            token_texts = [tm["token"].get("text", "") for tm in tokens_for_char]
            print(f"\nMERGED: {len(tokens_for_char)} tokens → '{char_info['char']}'")
            print(f"  Tokens: {token_texts}")
        char_idx += 1

    reconstructed_text = "".join(t["text"] for t in merged_tokens)
    if reconstructed_text != correct_text:
        raise WhisperCppConversionError(
            "Final text validation failed!\nExpected: '{}...'\nGot: '{}...'\n"
            "This indicates a bug in the token grouping logic.".format(
                correct_text[:DEBUG_PREVIEW_CHARS],
                reconstructed_text[:DEBUG_PREVIEW_CHARS],
            )
        )

    return merged_tokens


def _ms_to_seconds(value: int | float | None) -> float | None:
    """Convert millisecond timestamps to seconds with canonical precision."""
    if value is None:
        return None
    return round(float(value) / 1000.0, TIMESTAMP_PRECISION)


def _ensure_number(value: Any, *, label: str) -> None:
    """Validate that the value is a finite number (int/float) and non-negative."""

    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WhisperCppConversionError(f"{label} must be a number, got {type(value)}")
    if math.isnan(value) or math.isinf(value):
        raise WhisperCppConversionError(f"{label} must be finite, got {value}")
    if value < 0:
        raise WhisperCppConversionError(f"{label} must be non-negative, got {value}")


def _validate_segment_offsets(offsets: dict[str, Any]) -> None:
    """Ensure segment offsets are numeric, finite, and non-negative."""

    _ensure_number(offsets.get("from"), label="segment offsets.from")
    _ensure_number(offsets.get("to"), label="segment offsets.to")


def _validate_token_offsets(tokens: list[TokenDict]) -> None:
    """Ensure token offsets are numeric, finite, and non-negative when present."""

    for idx, token in enumerate(tokens):
        offsets = token.get("offsets") or {}
        _ensure_number(offsets.get("from"), label=f"token[{idx}] offsets.from")
        _ensure_number(offsets.get("to"), label=f"token[{idx}] offsets.to")


def _validate_canonical_output(output: dict) -> None:
    """Lightweight schema validation for the canonical transcript structure."""

    if not isinstance(output, dict):
        raise WhisperCppConversionError(f"Converted output must be a dict, got {type(output)}")

    segments = output.get("segments")
    if not isinstance(segments, list):
        raise WhisperCppConversionError("Converted output is missing 'segments' list")

    for seg_idx, segment in enumerate(segments):
        if not isinstance(segment, dict):
            raise WhisperCppConversionError(f"segment[{seg_idx}] must be an object")
        segment = cast(dict[str, Any], segment)
        start = segment.get("start")
        end = segment.get("end")
        _ensure_number(start, label=f"segment[{seg_idx}].start")
        _ensure_number(end, label=f"segment[{seg_idx}].end")
        if start is None or end is None:
            raise WhisperCppConversionError(f"segment[{seg_idx}] is missing start/end")
        if end < start - TIMESTAMP_EPS:
            raise WhisperCppConversionError(
                f"segment[{seg_idx}] has end < start (start={start}, end={end})"
            )

        words = segment.get("words")
        if not isinstance(words, list):
            raise WhisperCppConversionError(f"segment[{seg_idx}] words must be a list")

        last_word_end = start
        for word_idx, word in enumerate(words):
            if not isinstance(word, dict):
                raise WhisperCppConversionError(
                    f"segment[{seg_idx}].words[{word_idx}] must be an object"
                )
            word = cast(dict[str, Any], word)
            w_start = word.get("start")
            w_end = word.get("end")
            _ensure_number(w_start, label=f"segment[{seg_idx}].words[{word_idx}].start")
            _ensure_number(w_end, label=f"segment[{seg_idx}].words[{word_idx}].end")
            if w_start is None or w_end is None:
                raise WhisperCppConversionError(
                    f"segment[{seg_idx}].words[{word_idx}] missing start/end"
                )
            if w_start < start - TIMESTAMP_EPS or w_end > end + TIMESTAMP_EPS:
                raise WhisperCppConversionError(
                    f"segment[{seg_idx}].words[{word_idx}] outside segment bounds"
                )
            if w_start < last_word_end - TIMESTAMP_EPS:
                raise WhisperCppConversionError(
                    f"segment[{seg_idx}].words not monotonic at index {word_idx}"
                )
            if w_end < w_start - TIMESTAMP_EPS:
                raise WhisperCppConversionError(f"segment[{seg_idx}].words[{word_idx}] end < start")
            last_word_end = w_end


def _mean(values: Iterable[float]) -> float | None:
    """Return the arithmetic mean ignoring None/NaN values."""
    total = 0.0
    count = 0
    for item in values:
        if item is None or math.isnan(item):
            continue
        total += float(item)
        count += 1
    if count == 0:
        return None
    return total / count


def _validate_words_match_segment(words: list[dict], segment_text: str) -> None:
    """Ensure concatenated word texts match the whitespace-stripped segment text."""
    reconstructed_text = "".join(w["word"] for w in words)
    reconstructed_no_spaces = "".join(reconstructed_text.split())
    segment_no_spaces = "".join(segment_text.split())
    if reconstructed_no_spaces != segment_no_spaces:
        raise WhisperCppConversionError(
            "Word reconstruction TEXT validation failed!\n"
            "Expected (segment without spaces): '{}'...\n"
            "Got (joined words): '{}'...\nExpected length: {}\nReconstructed length: {}\n"
            "Word count: {}\nThis indicates a bug in the word building logic.".format(
                segment_no_spaces[:DEBUG_PREVIEW_CHARS],
                reconstructed_text[:DEBUG_PREVIEW_CHARS],
                len(segment_no_spaces),
                len(reconstructed_no_spaces),
                len(words),
            )
        )


def _shift_token_timestamp(
    value_ms: int | float | None,
    segment_token_start_ms: int | float | None,
    segment_start: float,
) -> float | None:
    """Shift token timestamps into absolute time using the segment start offset."""
    if value_ms is None or segment_token_start_ms is None:
        return None
    delta_ms = (segment_start * 1000.0) - float(segment_token_start_ms)
    return round((float(value_ms) + delta_ms) / 1000.0, TIMESTAMP_PRECISION)


def _normalize_token_timestamp(
    value_ms: int | float | None,
    token_start_ms: int | float | None,
    token_end_ms: int | float | None,
    segment_start: float,
    segment_end: float,
) -> float | None:
    """Project a token timestamp onto the segment window using linear scaling."""
    if value_ms is None or token_start_ms is None or token_end_ms is None:
        return None

    token_start_ms = float(token_start_ms)
    token_end_ms = float(token_end_ms)
    if token_end_ms <= token_start_ms:
        return None

    segment_duration = max(0.0, float(segment_end) - float(segment_start))
    if segment_duration == 0.0:
        return round(float(segment_start), TIMESTAMP_PRECISION)

    ratio = (float(value_ms) - token_start_ms) / (token_end_ms - token_start_ms)
    ratio = max(0.0, min(1.0, ratio))
    projected = float(segment_start) + ratio * segment_duration
    return round(projected, TIMESTAMP_PRECISION)


def _build_words_from_tokens(
    merged_tokens: list[TokenDict],
    segment_text: str,
    segment_start: float,
    segment_end: float,
) -> list[dict]:
    """Group merged tokens into words using whitespace boundaries and timestamps."""
    if not merged_tokens:
        return []

    token_froms = [
        t.get("offsets", {}).get("from")
        for t in merged_tokens
        if t.get("offsets", {}).get("from") is not None
    ]
    token_tos = [
        t.get("offsets", {}).get("to")
        for t in merged_tokens
        if t.get("offsets", {}).get("to") is not None
    ]
    segment_token_start = min(token_froms) if token_froms else None
    segment_token_end = max(token_tos) if token_tos else None
    if (
        segment_token_start is not None
        and segment_token_end is not None
        and segment_token_end <= segment_token_start
    ):
        segment_token_start = segment_token_end = None

    words = []
    current_word_tokens: list[TokenDict] = []

    for token in merged_tokens:
        token_text = token.get("text", "")
        leading_char = token_text[:1]
        starts_new_word = bool(leading_char and leading_char.isspace())
        if starts_new_word:
            if current_word_tokens:
                word_dict = _create_word_from_token_group(
                    current_word_tokens,
                    segment_start,
                    segment_end,
                    segment_token_start,
                    segment_token_end,
                )
                if word_dict:
                    words.append(word_dict)
            if token_text.strip():
                current_word_tokens = [token]
            else:
                current_word_tokens = []
        else:
            current_word_tokens.append(token)

    if current_word_tokens:
        word_dict = _create_word_from_token_group(
            current_word_tokens,
            segment_start,
            segment_end,
            segment_token_start,
            segment_token_end,
        )
        if word_dict:
            words.append(word_dict)

    _validate_words_match_segment(words, segment_text)
    return words


def _create_word_from_token_group(
    tokens: list[TokenDict],
    segment_start: float,
    segment_end: float,
    segment_token_start: int | float | None,
    segment_token_end: int | float | None,
) -> dict | None:
    """Build a canonical word entry from a group of contiguous tokens."""
    if not tokens:
        return None

    word_text = "".join(t.get("text", "") for t in tokens).strip()
    if not word_text:
        return None

    first_token = tokens[0]
    last_token = tokens[-1]
    start_ms = first_token.get("offsets", {}).get("from")
    end_ms = last_token.get("offsets", {}).get("to")

    start = _normalize_token_timestamp(
        start_ms, segment_token_start, segment_token_end, segment_start, segment_end
    )
    end = _normalize_token_timestamp(
        end_ms, segment_token_start, segment_token_end, segment_start, segment_end
    )
    if start is None:
        start = _shift_token_timestamp(start_ms, segment_token_start, segment_start)
    if end is None:
        end = _shift_token_timestamp(end_ms, segment_token_start, segment_start)
    if start is None:
        start = _ms_to_seconds(start_ms) if start_ms is not None else segment_start
    if end is None:
        end = _ms_to_seconds(end_ms) if end_ms is not None else segment_end
    assert start is not None
    assert end is not None

    start = max(segment_start, min(start, segment_end))
    end = max(segment_start, min(end, segment_end))
    if end < start:
        end = start

    confidences = [float(value) for t in tokens if (value := t.get("p")) is not None]
    confidence = _mean(confidences) if confidences else None

    return {
        "word": word_text,
        "start": start,
        "end": end,
        "confidence": confidence,
    }


def convert_whisper_cpp(
    payload: PayloadDict,
    source_encoding: str = "latin-1",
    *,
    duration_seconds: float,
    audio_filepath: str | None = None,
) -> dict:
    """Convert a whisper.cpp JSON payload into the canonical alignment schema.

    Duration must be supplied by the caller; no catalog/ffprobe is performed here.
    """
    if not isinstance(payload, dict):
        raise WhisperCppConversionError(f"Expected dict payload, got {type(payload)}")

    if "transcription" not in payload:
        raise WhisperCppConversionError("Missing required 'transcription' field in payload")

    transcription = payload.get("transcription")
    if not isinstance(transcription, list):
        raise WhisperCppConversionError("'transcription' must be a list")

    params = payload.get("params") or {}
    model = payload.get("model") or {}
    systeminfo = payload.get("systeminfo") or {}

    segments = []
    for seg_idx, raw_segment in enumerate(transcription):
        offsets = raw_segment.get("offsets") or {}
        _validate_segment_offsets(offsets)
        start = _ms_to_seconds(offsets.get("from")) or 0.0
        end = _ms_to_seconds(offsets.get("to")) or start
        if end < start - TIMESTAMP_EPS:
            raise WhisperCppConversionError(
                f"Segment {seg_idx} has end < start (start={start}, end={end})"
            )
        raw_text = raw_segment.get("text", "")

        tokens = raw_segment.get("tokens", [])
        if raw_text.strip() and not tokens:
            raise WhisperCppConversionError(
                f"Segment {seg_idx} has text but no tokens; conversion would drop content."
            )
        _validate_token_offsets(tokens)
        merged_tokens = _merge_broken_utf8_tokens(
            tokens,
            raw_text,
            source_encoding=source_encoding,
        )

        segment_text = _decode_segment_text(raw_text, source_encoding)

        words = _build_words_from_tokens(merged_tokens, segment_text, start, end)

        if segment_text.strip() and not words:
            raise WhisperCppConversionError(
                f"Segment {seg_idx} produced no words after reconstruction; input is inconsistent."
            )

        normalized_words: list[dict] = []
        last_end = start
        for word in words:
            word_start = word["start"]
            word_end = word["end"]

            if word_start < start - TIMESTAMP_EPS or word_end > end + TIMESTAMP_EPS:
                raise WhisperCppConversionError(
                    f"Word timing outside segment bounds in segment {seg_idx}: "
                    f"word_start={word_start}, word_end={word_end}, segment=[{start}, {end}]"
                )
            if word_start < last_end - TIMESTAMP_EPS:
                raise WhisperCppConversionError(
                    f"Non-monotonic word timings in segment {seg_idx}: "
                    f"word_start={word_start} < previous_end={last_end}"
                )
            if word_end < word_start - TIMESTAMP_EPS:
                raise WhisperCppConversionError(
                    f"Word end precedes start in segment {seg_idx}: "
                    f"word_start={word_start}, word_end={word_end}"
                )
            normalized_words.append(
                {
                    "start": word_start,
                    "end": word_end,
                    "word": word["word"],
                    "confidence": word["confidence"],
                }
            )
            last_end = word_end

        segment_confidence = _mean(
            word["confidence"] for word in words if word["confidence"] is not None
        )

        segments.append(
            {
                "start": start,
                "end": end,
                "text": segment_text.strip(),
                "confidence": segment_confidence,
                "words": normalized_words,
            }
        )

    # Use provided audio_filepath if set, else fall back to payload's result.audio
    audio_path_str = audio_filepath or payload.get("result", {}).get("audio") or None

    meta = {
        "backend": "whisper.cpp",
        "model": params.get("model") or model.get("name"),
        "audio_filepath": audio_path_str,
        "duration": round(float(duration_seconds), 3),
        "generation_params": {
            "language": payload.get("result", {}).get("language"),
            **{k: v for k, v in params.items()},
        },
        "systeminfo": systeminfo,
    }

    output = {"meta": meta, "segments": segments}
    _validate_canonical_output(output)
    return output


_catalog_cache: dict[Path, dict[str, Path]] = {}


def _load_catalog(catalog_path: Path) -> dict[str, Path]:
    if catalog_path in _catalog_cache:
        return _catalog_cache[catalog_path]

    mapping: dict[str, Path] = {}
    with catalog_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            sha = (row.get("Hash") or "").strip()
            full_path = (row.get("Full Path") or "").strip()
            if sha and full_path:
                mapping[sha] = Path(full_path)
    _catalog_cache[catalog_path] = mapping
    return mapping


def _infer_catalog_path(input_path: Path) -> Path | None:
    # Expect path like .../transcripts_<ts>/whisper.cpp/.../<hash>/transcript_original.json
    for candidate_path in (input_path, input_path.resolve()):
        for ancestor in [candidate_path] + list(candidate_path.parents):
            ts = extract_timestamp_from_transcripts_root(ancestor)
            if ts:
                candidate = ancestor.parent / f"audio_catalog_{ts}_normalized.csv"
                if candidate.is_file():
                    return candidate
    return None


def resolve_durations_from_catalog(
    catalog_path: Path, transcript_files: list[Path]
) -> dict[Path, tuple[float, Path]]:
    """Return duration and audio path for each transcript file using one catalog load.

    Files whose hash is missing from the catalog or whose audio file does not
    exist are omitted from the result; callers handle them per-file so that one
    unresolvable entry cannot fail the whole batch.
    """

    catalog_map = _load_catalog(catalog_path)
    results: dict[Path, tuple[float, Path]] = {}

    for tf in transcript_files:
        hash_dir = tf.parent.name
        audio_path = catalog_map.get(hash_dir)
        if audio_path is None:
            print(f"  Skipping {hash_dir}: hash not found in catalog {catalog_path}")
            continue
        if not audio_path.is_file():
            print(f"  Skipping {hash_dir}: audio file missing: {audio_path}")
            continue
        duration = measure_audio_duration_seconds(audio_path)
        results[tf] = (duration, audio_path)

    return results


def process_with_catalog(
    transcript_files: list[Path],
    catalog_path: Path,
    indent: int,
    *,
    skip_existing: bool = True,
) -> tuple[int, int, int]:
    """Process a batch with a single catalog lookup; returns (processed, failed, skipped)."""

    # Filter to pending files BEFORE resolving durations to avoid:
    # 1. Wasted I/O probing durations for files that will be skipped
    # 2. Failures when already-converted entries are missing from catalog/audio
    if skip_existing:
        pending_files = []
        skipped = 0
        for src in transcript_files:
            out_path = src.parent / "transcript.json"
            if out_path.exists():
                skipped += 1
            else:
                pending_files.append(src)
    else:
        pending_files = transcript_files
        skipped = 0

    if not pending_files:
        return 0, 0, skipped

    # Resolve durations for all pending files in one catalog load. Entries the
    # catalog can't resolve are simply absent from the map and handled per-file
    # below; a hard failure here (e.g. an unreadable audio file) fails the batch
    # gracefully rather than crashing the CLI.
    try:
        duration_map = resolve_durations_from_catalog(catalog_path, pending_files)
    except Exception as exc:  # pragma: no cover - CLI safety
        print(f"Catalog lookup error:\n  {type(exc).__name__}: {exc}")
        traceback.print_exc()
        return 0, len(pending_files), skipped

    processed = failed = 0
    for src in pending_files:
        out_path = src.parent / "transcript.json"
        if src not in duration_map:
            # Unresolvable entry; resolve_durations_from_catalog already
            # reported the specific reason (missing hash vs missing audio).
            failed += 1
            continue
        try:
            duration, audio_path = duration_map[src]
            convert_file(
                src,
                out_path,
                indent,
                duration_seconds=duration,
                audio_filepath=str(audio_path),
            )
            processed += 1
        except WhisperCppConversionError as exc:
            print(f"Conversion error in {src}:\n  {exc}")
            failed += 1
        except json.JSONDecodeError as exc:
            print(f"JSON parse error in {src}:\n  {exc}")
            failed += 1
        except Exception as exc:  # pragma: no cover - CLI safety
            print(f"Unexpected error converting {src}:\n  {type(exc).__name__}: {exc}")
            traceback.print_exc()
            failed += 1

    return processed, failed, skipped


def convert_file(
    input_path: Path,
    output_path: Path | None,
    indent: int,
    *,
    duration_seconds: float,
    audio_filepath: str | None = None,
) -> None:
    """Load, convert, and optionally write a single transcript file.

    duration_seconds is required; no catalog or ffprobe lookups happen here.
    """
    source_encoding = "utf-8"
    try:
        with input_path.open(encoding="utf-8") as handle:
            payload = json.load(handle)
    except UnicodeDecodeError:
        source_encoding = "latin-1"
        text = input_path.read_text(encoding="latin-1")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            raise json.JSONDecodeError(
                f"File {input_path} is not valid JSON: {exc.msg}", exc.doc, exc.pos
            )
    except json.JSONDecodeError as exc:
        raise json.JSONDecodeError(
            f"File {input_path} is not valid JSON: {exc.msg}", exc.doc, exc.pos
        )

    converted = convert_whisper_cpp(
        payload,
        source_encoding=source_encoding,
        duration_seconds=duration_seconds,
        audio_filepath=audio_filepath,
    )
    serialized = json.dumps(converted, ensure_ascii=False, indent=indent)

    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(serialized, encoding="utf-8")
        print(f"Converted: {input_path} -> {output_path}")
    else:
        print(serialized)


def find_transcript_files(root: Path) -> list[Path]:
    """Return all transcript_original.json files under the given root."""

    return sorted(root.rglob("transcript_original.json"))


def main() -> None:
    """CLI entry point for whisper.cpp transcript conversion."""
    parser = argparse.ArgumentParser(
        description="Convert whisper.cpp transcript JSON to canonical schema."
    )
    parser.add_argument(
        "input",
        nargs="?",
        type=Path,
        help="Path to whisper.cpp transcript_original.json or directory (default: transcripts/whisper.cpp)",
    )
    parser.add_argument("--indent", type=int, default=2, help="Indentation level for JSON output")
    parser.add_argument(
        "--catalog",
        type=Path,
        required=True,
        help="Path to audio_catalog_<ts>_normalized.csv for duration lookup when payload lacks audio path.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-conversion even if transcript.json already exists.",
    )
    args = parser.parse_args()

    default_dir = Path("transcripts") / WHISPER_CPP_DIRNAME
    input_arg = args.input if args.input is not None else default_dir
    input_path = resolve_project_path(input_arg)

    catalog_path = args.catalog.resolve()

    inferred_catalog = _infer_catalog_path(input_path)
    if inferred_catalog and inferred_catalog.resolve() != catalog_path:
        raise RuntimeError(
            f"Catalog mismatch: supplied {catalog_path} vs inferred {inferred_catalog}"
        )

    skip_existing = not args.force

    if input_path.is_dir():
        transcript_files = find_transcript_files(input_path)
        if not transcript_files:
            print(f"No transcript_original.json files found in {input_path}")
            return
        print(f"Found {len(transcript_files)} transcript_original.json file(s)")
        processed, failed, skipped = process_with_catalog(
            transcript_files, catalog_path, args.indent, skip_existing=skip_existing
        )
        print(f"\nProcessed {processed}, skipped {skipped}, failed {failed}")
        if failed:
            raise SystemExit(1)
        return

    if not input_path.is_file():
        print(f"Error: {input_path} is not a file")
        return

    # Single file path -> process via the same batch helper for consistency
    processed, failed, skipped = process_with_catalog(
        [input_path], catalog_path, args.indent, skip_existing=skip_existing
    )
    print(f"\nProcessed {processed}, skipped {skipped}, failed {failed}")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
