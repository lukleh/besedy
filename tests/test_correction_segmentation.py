"""Correction spans from decoded chunks must match contracts/correction-segmentation.json.

web/tests/unit/correction-segmentation-contract.test.ts checks the TypeScript
port against the same file, so the web import and the training export cannot
cut different spans. The expected outputs come from this module; the
per-case assertions below state independently what each rule must do.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from besedy.lib import correction_segmentation as cs

CONTRACT_PATH = Path(__file__).resolve().parents[1] / "contracts" / "correction-segmentation.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
CASES = {case["name"]: case for case in CONTRACT["cases"]}


def _run(name: str) -> cs.Segmentation:
    return cs.segment_transcript(CASES[name]["transcript"])


def _ranges(result: cs.Segmentation) -> list[tuple[int, int]]:
    return [(span.first_region, span.last_region) for span in result.spans]


def _texts(result: cs.Segmentation) -> list[str]:
    return [span.text for span in result.spans]


def test_contract_parameters_match_module() -> None:
    assert CONTRACT["version"] == cs.SEGMENTATION_VERSION
    assert CONTRACT["params"] == cs.Segmentation(version="", chunk_count=0, spans=()).params


@pytest.mark.parametrize("case", CONTRACT["cases"], ids=lambda case: case["name"])
def test_case_matches_contract(case: dict) -> None:
    expected = case["expected"]
    if "error" in expected:
        with pytest.raises(cs.SegmentationError) as excinfo:
            cs.segment_transcript(case["transcript"])
        assert excinfo.value.code == expected["error"]
        return
    result = cs.segment_transcript(case["transcript"])
    assert result.chunk_count == expected["chunkCount"]
    assert [cs.span_to_contract(span) for span in result.spans] == expected["spans"]


@pytest.mark.parametrize(
    "case",
    [case for case in CONTRACT["cases"] if "error" not in case["expected"]],
    ids=lambda case: case["name"],
)
def test_spans_partition_chunks(case: dict) -> None:
    """Every region belongs to one span, in order, and no span crosses a chunk."""
    transcript = case["transcript"]
    result = cs.segment_transcript(transcript)
    regions = [
        cs.Region(c["start"], c["end"])
        for c in transcript["meta"]["generation_params"]["transcription_options"]["clip_timestamps"]
    ]
    chunk_of = {i: c for c, chunk in enumerate(cs.build_chunks(regions)) for i in chunk}
    covered = [i for span in result.spans for i in range(span.first_region, span.last_region + 1)]
    assert covered == list(range(len(regions)))
    for span in result.spans:
        assert chunk_of[span.first_region] == chunk_of[span.last_region] == span.chunk
        if span.first_region != span.last_region:
            assert span.end_sample - span.start_sample <= cs.MAX_SPAN_SAMPLES
        assert span.regions == tuple(regions[span.first_region : span.last_region + 1])


# Cases whose spans fall back to their words joined by spaces, so the segment
# text is not what the spans are cut from.
JOINED_WORDS_CASES = {
    "words_not_found_fall_back_to_joined_words",
    "word_order_regresses_across_spans",
}


@pytest.mark.parametrize(
    "case",
    [
        case
        for case in CONTRACT["cases"]
        if "error" not in case["expected"] and case["name"] not in JOINED_WORDS_CASES
    ],
    ids=lambda case: case["name"],
)
def test_span_texts_keep_every_character(case: dict) -> None:
    def squash(text: str) -> str:
        return re.sub(r"\s+", "", cs.normalize_span_text(text))

    result = cs.segment_transcript(case["transcript"])
    for chunk, segment in enumerate(case["transcript"]["segments"]):
        joined = "".join(span.text for span in result.spans if span.chunk == chunk)
        assert squash(joined) == squash(segment["text"])


@pytest.mark.parametrize("example", CONTRACT["normalization"], ids=lambda e: e["why"])
def test_normalization_matches_contract(example: dict) -> None:
    assert cs.normalize_span_text(example["input"]) == example["expected"]


def test_regions_pack_by_speech_not_by_silence() -> None:
    assert _run("chunk_packing").chunk_count == 2
    assert _ranges(_run("chunk_packing")) == [(0, 2), (3, 3)]
    assert _run("long_pause_inside_chunk").chunk_count == 1


def test_split_needs_a_full_second_of_silence() -> None:
    assert _ranges(_run("split_at_one_second_gap")) == [(0, 1), (2, 2)]
    assert _ranges(_run("long_pause_inside_chunk")) == [(0, 0), (1, 1)]


def test_runs_over_30_seconds_are_split_sensibly() -> None:
    assert _ranges(_run("split_long_run_at_widest_gap")) == [(0, 6), (7, 13)]
    assert _ranges(_run("split_long_run_equal_gaps_splits_evenly")) == [(0, 5), (6, 11)]
    assert _ranges(_run("split_long_run_prefers_parts_within_30s")) == [(0, 6), (7, 13)]
    # No cut fits both parts within 30 s: the widest pause (after region 9)
    # wins, and the 30-region remainder is cut again, evenly.
    assert _ranges(_run("split_long_run_no_cut_fits_falls_back_to_widest_gap")) == [
        (0, 9),
        (10, 24),
        (25, 39),
    ]


def test_short_spans_merge_within_30_seconds() -> None:
    assert _ranges(_run("merge_short_across_shorter_gap")) == [(0, 1), (2, 2)]
    assert _ranges(_run("merge_short_tie_prefers_previous")) == [(0, 1), (2, 2)]
    assert _ranges(_run("merge_short_refused_over_30s")) == [(0, 0), (1, 1)]
    assert _ranges(_run("merge_short_falls_back_to_other_neighbour")) == [(0, 9), (10, 11)]
    assert _ranges(_run("short_spans_merge_repeatedly")) == [(0, 2), (3, 3)]
    assert _ranges(_run("merge_short_refused_on_both_sides")) == [(0, 0), (1, 1), (2, 2)]


def test_spans_never_cross_chunks() -> None:
    result = _run("two_chunks_spans_never_cross")
    assert [(span.chunk, span.first_region, span.last_region) for span in result.spans] == [
        (0, 0, 1),
        (1, 2, 2),
    ]


def test_words_go_to_the_span_holding_their_midpoint() -> None:
    result = _run("word_in_removed_silence_goes_to_nearest_region")
    assert [span.word_indices for span in result.spans] == [(0, 1), (2, 3)]
    assert _texts(_run("merge_short_across_shorter_gap")) == ["Tak jsme šli. A", "pak domů."]
    outside = _run("words_outside_all_regions_go_to_nearest_span")
    assert [span.word_indices for span in outside.spans] == [(0, 1), (2, 3)]
    assert _texts(outside) == ["Před začátkem.", "Po konci."]
    bad_times = _run("words_with_missing_or_non_numeric_times")
    assert [span.word_indices for span in bad_times.spans] == [(0, 1, 2), (3, 4)]
    assert _texts(bad_times) == ["Jedna dva tři", "čtyři pět."]


def test_span_text_is_cut_from_the_segment_text() -> None:
    assert _texts(_run("text_keeps_hyphen_spacing")) == ["Já chci říkat ex-kidlo."]
    assert _texts(_run("text_cut_at_first_word_of_each_span")) == [
        "„Pojď sem,“ řekl.",
        "Pak odešel.",
    ]
    assert _texts(_run("words_not_found_fall_back_to_joined_words")) == ["Tady je", "něco jiného."]
    assert _texts(_run("word_order_regresses_across_spans")) == ["Jedna tři.", "dva"]
    assert _texts(_run("text_without_words_goes_to_first_span")) == ["Bez časů slov.", ""]
    assert _texts(_run("empty_segment")) == ["", ""]


def test_sources_that_cannot_be_segmented_are_refused() -> None:
    for name, code in (
        ("refuse_without_regions", "NO_REGIONS"),
        ("refuse_chunk_mismatch", "CHUNK_MISMATCH"),
        ("refuse_region_over_30s", "CHUNK_MISMATCH"),
        ("refuse_unsorted_regions", "NO_REGIONS"),
        ("refuse_overlapping_regions", "NO_REGIONS"),
        ("refuse_empty_region", "NO_REGIONS"),
        ("refuse_non_list_segments", "CHUNK_MISMATCH"),
        ("refuse_non_object_meta", "NO_REGIONS"),
    ):
        with pytest.raises(cs.SegmentationError) as excinfo:
            _run(name)
        assert excinfo.value.code == code


def _transcript(clips: list[tuple[int, int]], segments: object) -> dict:
    return {
        "meta": {
            "generation_params": {
                "transcription_options": {
                    "clip_timestamps": [{"start": a, "end": b} for a, b in clips]
                }
            }
        },
        "segments": segments,
    }


def _refused(transcript: dict, code: str) -> str:
    with pytest.raises(cs.SegmentationError) as excinfo:
        cs.segment_transcript(transcript)
    assert excinfo.value.code == code
    return str(excinfo.value)


ONE_REGION = [(0, 64000)]


def test_segments_must_be_a_list() -> None:
    """A dict is not iterated as its keys: it counts as no segments at all."""
    segment = {"text": "Ahoj.", "words": []}
    _refused(_transcript(ONE_REGION, {"0": segment}), "CHUNK_MISMATCH")
    _refused(_transcript(ONE_REGION, "Ahoj."), "CHUNK_MISMATCH")
    _refused(_transcript(ONE_REGION, 1), "CHUNK_MISMATCH")
    assert _texts(cs.segment_transcript(_transcript(ONE_REGION, [segment]))) == ["Ahoj."]


@pytest.mark.parametrize("meta", ["none", 5, ["generation_params"], None])
def test_non_object_meta_levels_are_refused_not_crashed(meta: object) -> None:
    segments = [{"text": "Ahoj.", "words": []}]
    _refused({"meta": meta, "segments": segments}, "NO_REGIONS")
    _refused({"meta": {"generation_params": meta}, "segments": segments}, "NO_REGIONS")
    _refused(
        {"meta": {"generation_params": {"transcription_options": meta}}, "segments": segments},
        "NO_REGIONS",
    )
    assert _texts(cs.segment_transcript(_transcript(ONE_REGION, segments))) == ["Ahoj."]


def test_non_string_text_and_word_read_as_empty() -> None:
    def spans_of(text: object, word: object) -> list[str]:
        segment = {"text": text, "words": [{"word": word, "start": 0.5, "end": 1.0}]}
        return _texts(cs.segment_transcript(_transcript(ONE_REGION, [segment])))

    assert spans_of("Ahoj.", "Ahoj.") == ["Ahoj."]
    for value in (None, 0, 1, 1.5, True, ["Ahoj."], {"word": "Ahoj."}):
        assert spans_of(value, "Ahoj.") == ["Ahoj."]  # words joined, text ignored
        assert spans_of("Ahoj.", value) == ["Ahoj."]  # text kept, word skipped
    assert spans_of(0, 0) == [""]


def test_regions_must_be_ordered_and_non_empty() -> None:
    segments = [{"text": "", "words": []}]
    for clips in (
        [(10, 20), (0, 5)],  # unsorted
        [(0, 10), (5, 15)],  # overlapping
        [(0, 10), (10, 10)],  # empty
        [(10, 5)],  # end before start
        [(-5, 10)],  # before the audio starts
    ):
        message = _refused(_transcript(clips, segments), "NO_REGIONS")
        assert "regions must be ordered and non-empty" in message
    for clip in (
        {"start": 0.5, "end": 10},  # fractional sample
        {"start": 0, "end": float("nan")},
        {"start": 0, "end": float("inf")},
        {"start": "0", "end": 10},
        {"start": False, "end": 10},
        {"end": 10},
    ):
        transcript = _transcript([], segments)
        transcript["meta"]["generation_params"]["transcription_options"]["clip_timestamps"] = [clip]
        message = _refused(transcript, "NO_REGIONS")
        assert "Malformed clip_timestamps entry" in message
    # Touching regions are valid VAD output.
    result = cs.segment_transcript(_transcript([(0, 32000), (32000, 64000)], segments))
    assert _ranges(result) == [(0, 1)]
    assert cs.segment_transcript(_transcript([(0, 1), (16000.0, 32000)], segments)).chunk_count == 1
