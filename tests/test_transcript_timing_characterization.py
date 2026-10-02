"""Characterization tests for word/segment timing in the clamping writers.

faster-whisper, the WhisperX converter and the stable-ts converter share the
same timing code: overlapping segments are pushed forward, words are clamped to
their segment and then made monotonic. These tests pin what that code does
today, including results that look wrong (a word after its segment's end
comes out with end < start). They describe current behaviour, not a contract:
model output is messy by nature, and any change here must be deliberate and
backed by a study of real transcripts.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from besedy.cli.convert_stable_ts import convert_stable_ts
from besedy.lib.data.whisperx_conversion import convert_whisperx

# The faster-whisper runner imports its ML backend at module scope. Stub it only
# when the optional extra is absent (same guard as test_transcript_atomic_writes).
if (
    "faster_whisper" not in sys.modules and importlib.util.find_spec("faster_whisper") is None
):  # pragma: no cover - env dependent
    sys.modules.setdefault("faster_whisper", MagicMock())
    sys.modules.setdefault("faster_whisper.vad", MagicMock())

from besedy.workflows import transcribe_faster_whisper as faster_whisper_module  # noqa: E402

RawSegment = dict[str, Any]


def _faster_whisper(segments: list[RawSegment], monkeypatch) -> dict[str, Any]:
    monkeypatch.setattr(faster_whisper_module, "measure_audio_duration_seconds", lambda _p: 60.0)
    fw_segments = [
        SimpleNamespace(
            start=seg.get("start"),
            end=seg.get("end"),
            text=seg.get("text", ""),
            words=[SimpleNamespace(probability=None, **word) for word in seg.get("words", [])],
        )
        for seg in segments
    ]
    return faster_whisper_module.build_payload(
        Path("audio.wav"),
        model_name="large-v3",
        device="cpu",
        compute_type="int8",
        language="cs",
        batch_size=1,
        vad_filter=False,
        min_silence_ms=None,
        word_timestamps=True,
        info=None,
        segments=fw_segments,
    )


def _whisperx(segments: list[RawSegment], _monkeypatch) -> dict[str, Any]:
    return convert_whisperx(
        {"segments": segments},
        backend="whisperx",
        model="large-v3",
        duration_seconds=60.0,
        audio_filepath=None,
    )


def _stable_ts(segments: list[RawSegment], _monkeypatch) -> dict[str, Any]:
    return convert_stable_ts(
        {"segments": segments},
        backend="stable-ts",
        model="large-v3",
        duration_seconds=60.0,
        audio_filepath=None,
    )


WRITERS = {
    "faster-whisper": _faster_whisper,
    "whisperx": _whisperx,
    "stable-ts": _stable_ts,
}


def _word(text: str, start: float | None, end: float | None) -> dict[str, Any]:
    return {"word": text, "start": start, "end": end}


def _seg(start: float, end: float, *words: dict[str, Any]) -> RawSegment:
    return {
        "start": start,
        "end": end,
        "text": " ".join(w["word"] for w in words),
        "words": list(words),
    }


# (input segments, expected [(segment start, end, [(word, start, end), ...]), ...])
CASES = {
    "word_inside_segment": (
        [_seg(0.0, 10.0, _word("a", 1.0, 2.0))],
        [(0.0, 10.0, [("a", 1.0, 2.0)])],
    ),
    "word_starts_before_segment": (
        [_seg(5.0, 10.0, _word("a", 4.0, 6.0))],
        [(5.0, 10.0, [("a", 5.0, 6.0)])],
    ),
    "word_ends_after_segment": (
        [_seg(5.0, 10.0, _word("a", 9.0, 11.0))],
        [(5.0, 10.0, [("a", 9.0, 10.0)])],
    ),
    # Pinned on purpose: the clamp yields end < start for this word.
    "word_after_segment_end": (
        [_seg(5.0, 10.0, _word("a", 12.0, 13.0))],
        [(5.0, 10.0, [("a", 12.0, 10.0)])],
    ),
    "word_before_segment_start": (
        [_seg(5.0, 10.0, _word("a", 2.0, 3.0))],
        [(5.0, 10.0, [("a", 5.0, 5.0)])],
    ),
    "word_end_before_its_start": (
        [_seg(0.0, 10.0, _word("a", 3.0, 2.0))],
        [(0.0, 10.0, [("a", 3.0, 3.0)])],
    ),
    "word_overlaps_previous_word": (
        [_seg(0.0, 10.0, _word("a", 1.0, 3.0), _word("b", 2.0, 4.0))],
        [(0.0, 10.0, [("a", 1.0, 3.0), ("b", 3.0, 4.0)])],
    ),
    # The out-of-segment word above becomes the previous word's end (10.0),
    # so the next word is pushed to a zero-length span at 10.0.
    "word_after_out_of_segment_word": (
        [_seg(5.0, 10.0, _word("a", 12.0, 13.0), _word("b", 6.0, 7.0))],
        [(5.0, 10.0, [("a", 12.0, 10.0), ("b", 10.0, 10.0)])],
    ),
    "word_without_timings": (
        [_seg(5.0, 10.0, _word("a", None, None))],
        [(5.0, 10.0, [("a", 5.0, 5.0)])],
    ),
    "word_with_only_end": (
        [_seg(5.0, 10.0, _word("a", None, 7.0))],
        [(5.0, 10.0, [("a", 7.0, 7.0)])],
    ),
    "empty_word_is_dropped": (
        [_seg(0.0, 10.0, _word("  ", 1.0, 2.0), _word("b", 3.0, 4.0))],
        [(0.0, 10.0, [("b", 3.0, 4.0)])],
    ),
    "segment_overlaps_previous_segment": (
        [_seg(0.0, 10.0), _seg(8.0, 12.0, _word("b", 8.5, 11.0))],
        [(0.0, 10.0, []), (10.0, 12.0, [("b", 10.0, 11.0)])],
    ),
    "segment_inside_previous_segment": (
        [_seg(0.0, 10.0), _seg(8.0, 9.0, _word("b", 8.5, 9.0))],
        [(0.0, 10.0, []), (10.0, 10.0, [("b", 10.0, 10.0)])],
    ),
    "gap_between_segments_is_kept": (
        [_seg(0.0, 2.0), _seg(5.0, 6.0)],
        [(0.0, 2.0, []), (5.0, 6.0, [])],
    ),
}


def _timings(payload: dict[str, Any]) -> list[tuple[float, float, list[tuple[str, float, float]]]]:
    return [
        (
            seg["start"],
            seg["end"],
            [(word["word"], word["start"], word["end"]) for word in seg["words"]],
        )
        for seg in payload["segments"]
    ]


@pytest.mark.parametrize("writer", sorted(WRITERS))
@pytest.mark.parametrize("case", sorted(CASES))
def test_current_timing_behaviour(writer: str, case: str, monkeypatch) -> None:
    segments, expected = CASES[case]
    payload = WRITERS[writer](segments, monkeypatch)
    assert _timings(payload) == expected
