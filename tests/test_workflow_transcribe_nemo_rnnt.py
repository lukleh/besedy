"""Timeline and artifact contracts for the optional RNNT workflow."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from besedy.lib.validation.schema import validate_canonical_schema
from besedy.workflows.transcribe_nemo_rnnt import (
    SAMPLE_RATE,
    bounded_regions,
    words_from_hypothesis,
    write_transcript,
)


def test_native_seconds_are_shifted_to_recording_time_once():
    hypothesis = SimpleNamespace(
        timestamp={
            "word": [
                {"word": "Dobrý", "start": 0.4, "end": 0.8, "start_offset": 5, "end_offset": 10},
                {"word": "den.", "start": 1.0, "end": 1.5, "start_offset": 12, "end_offset": 19},
            ]
        }
    )
    words = words_from_hypothesis(hypothesis, start=120.0, end=125.0, frame_seconds=0.08)
    assert [(w["start"], w["end"]) for w in words] == [(120.4, 120.8), (121.0, 121.5)]
    assert all(w["confidence"] is None for w in words)


def test_one_native_frame_can_be_clipped_to_chunk_boundary():
    hypothesis = SimpleNamespace(timestamp={"word": [{"word": "ano", "start": 0.9, "end": 1.04}]})
    assert words_from_hypothesis(hypothesis, start=10, end=11, frame_seconds=0.08)[0]["end"] == 11


@pytest.mark.parametrize("start,end", [(0.0, 12.0), (-1, 1), (1, 0), (0, float("nan"))])
def test_invalid_native_timing_is_not_interpolated_or_hidden(start, end):
    hypothesis = SimpleNamespace(timestamp={"word": [{"word": "ano", "start": start, "end": end}]})
    with pytest.raises(ValueError, match="Invalid RNNT word timestamp"):
        words_from_hypothesis(hypothesis, start=100, end=101, frame_seconds=0.08)


@pytest.mark.parametrize("timestamp", [None, {}, {"word": []}])
def test_nonempty_text_requires_native_timestamps(timestamp):
    with pytest.raises(ValueError, match="native word timestamps"):
        words_from_hypothesis(
            SimpleNamespace(timestamp=timestamp), start=0, end=1, frame_seconds=0.08
        )


def test_same_frame_words_keep_native_timing_and_pass_real_canonical_validator():
    hypothesis = SimpleNamespace(
        timestamp={
            "word": [
                {"word": "Dobrý", "start": 0.4, "end": 0.48},
                {"word": "den.", "start": 0.4, "end": 0.48},
            ]
        }
    )
    words = words_from_hypothesis(hypothesis, start=120, end=121, frame_seconds=0.08)
    assert [(word["start"], word["end"]) for word in words] == [
        (120.4, 120.48),
        (120.48, 120.48),
    ]
    payload = {
        "meta": {
            "model": "unified",
            "backend": "nemo-rnnt",
            "audio_filepath": "/audio.wav",
            "duration": 121,
            "generation_params": {},
        },
        "segments": [
            {"start": 120, "end": 121, "text": "Dobrý den.", "confidence": None, "words": words}
        ],
    }
    assert validate_canonical_schema(payload) == []


def test_large_native_word_overlap_is_not_hidden():
    hypothesis = SimpleNamespace(
        timestamp={
            "word": [
                {"word": "Dobrý", "start": 0.1, "end": 0.5},
                {"word": "den.", "start": 0.2, "end": 0.6},
            ]
        }
    )
    with pytest.raises(ValueError, match="overlap exceeds one encoder frame"):
        words_from_hypothesis(hypothesis, start=0, end=1, frame_seconds=0.08)


def test_vad_memory_bounds_preserve_all_speech_samples_and_gaps():
    regions = [
        {"start": SAMPLE_RATE, "end": 67 * SAMPLE_RATE},
        {"start": 70 * SAMPLE_RATE, "end": 71 * SAMPLE_RATE},
    ]
    chunks = bounded_regions(regions, 80 * SAMPLE_RATE)
    assert chunks == [
        (SAMPLE_RATE, 31 * SAMPLE_RATE),
        (31 * SAMPLE_RATE, 61 * SAMPLE_RATE),
        (61 * SAMPLE_RATE, 67 * SAMPLE_RATE),
        (70 * SAMPLE_RATE, 71 * SAMPLE_RATE),
    ]
    assert sum(end - start for start, end in chunks) == 67 * SAMPLE_RATE


@pytest.mark.parametrize(
    "regions",
    [
        [{"start": -1, "end": 1}],
        [{"start": 0, "end": 1001}],
        [{"start": 0, "end": 500}, {"start": 499, "end": 800}],
    ],
)
def test_invalid_vad_regions_fail_before_inference(regions):
    with pytest.raises(ValueError, match="VAD region"):
        bounded_regions(regions, 1000)


def test_transcript_sidecars_keep_original_recording_timeline(tmp_path):
    payload = {
        "meta": {"transcript_text": "Dobrý den."},
        "segments": [
            {"start": 120.4, "end": 121.5, "text": "Dobrý den.", "words": [], "confidence": None},
        ],
    }
    write_transcript(tmp_path, payload)
    assert json.loads((tmp_path / "transcript.json").read_text()) == payload
    assert (tmp_path / "transcript.txt").read_text() == "Dobrý den.\n"
    assert "00:02:00,400 --> 00:02:01,500" in (tmp_path / "transcript.srt").read_text()
    assert "00:02:00.400 --> 00:02:01.500" in (tmp_path / "transcript.vtt").read_text()
