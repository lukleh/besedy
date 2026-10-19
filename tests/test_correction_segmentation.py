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


@pytest.mark.parametrize(
    "case",
    [
        case
        for case in CONTRACT["cases"]
        if "error" not in case["expected"]
        and case["name"] != "words_not_found_fall_back_to_joined_words"
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


def test_short_spans_merge_within_30_seconds() -> None:
    assert _ranges(_run("merge_short_across_shorter_gap")) == [(0, 1), (2, 2)]
    assert _ranges(_run("merge_short_tie_prefers_previous")) == [(0, 1), (2, 2)]
    assert _ranges(_run("merge_short_refused_over_30s")) == [(0, 0), (1, 1)]
    assert _ranges(_run("merge_short_falls_back_to_other_neighbour")) == [(0, 9), (10, 11)]
    assert _ranges(_run("short_spans_merge_repeatedly")) == [(0, 2), (3, 3)]


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


def test_span_text_is_cut_from_the_segment_text() -> None:
    assert _texts(_run("text_keeps_hyphen_spacing")) == ["Já chci říkat ex-kidlo."]
    assert _texts(_run("text_cut_at_first_word_of_each_span")) == [
        "„Pojď sem,“ řekl.",
        "Pak odešel.",
    ]
    assert _texts(_run("words_not_found_fall_back_to_joined_words")) == ["Tady je", "něco jiného."]
    assert _texts(_run("text_without_words_goes_to_first_span")) == ["Bez časů slov.", ""]
    assert _texts(_run("empty_segment")) == ["", ""]


def test_sources_that_cannot_be_segmented_are_refused() -> None:
    for name, code in (
        ("refuse_without_regions", "NO_REGIONS"),
        ("refuse_chunk_mismatch", "CHUNK_MISMATCH"),
    ):
        with pytest.raises(cs.SegmentationError) as excinfo:
            _run(name)
        assert excinfo.value.code == code
