"""Regenerate contracts/correction-segmentation.json from its hand-designed cases.

Each case states the rule it exercises. Expected outputs come from the Python
reference (besedy/lib/correction_segmentation.py) and are asserted case by case,
independently, in tests/test_correction_segmentation.py. Review the diff of the
contract after every run: a changed expectation is a changed segmentation.

Usage: uv run python scripts/generate_correction_segmentation_contract.py [REAL_CASE_JSON]

The ``production_timing`` case is region and word timing from a production
transcript with placeholder words. Without REAL_CASE_JSON it is kept from the
current contract.
"""

import json
import sys
from pathlib import Path

from besedy.lib import correction_segmentation as cs

CONTRACT_PATH = Path(__file__).resolve().parents[1] / "contracts" / "correction-segmentation.json"

SR = cs.SAMPLE_RATE


def s(seconds):
    return int(round(seconds * SR))


def transcript(regions, segments):
    return {
        "meta": {
            "generation_params": {
                "transcription_options": {
                    "clip_timestamps": [{"start": s(a), "end": s(b)} for a, b in regions]
                }
            }
        },
        "segments": segments,
    }


def seg(text, words):
    return {"text": text, "words": [{"word": w, "start": a, "end": b} for w, a, b in words]}


def runs(spec, start=0.0):
    """Regions from [(speech_s, gap_after_s), ...] starting at `start`."""
    out, t = [], start
    for speech, gap in spec:
        out.append((t, t + speech))
        t += speech + gap
    return out


cases = []


def case(name, why, regions, segments):
    cases.append({"name": name, "why": why, "transcript": transcript(regions, segments)})


case(
    "single_region",
    "One region is one chunk and one span holding the whole segment text.",
    [(1.0, 6.0)],
    [
        seg(
            "Dobrý den, vítám vás.",
            [("Dobrý", 1.1, 1.5), ("den,", 1.5, 2.0), ("vítám", 2.2, 2.9), ("vás.", 3.0, 3.6)],
        )
    ],
)

case(
    "chunk_packing",
    "Regions pack into one chunk while their speech totals at most 30 s; the fourth 10 s region starts a new chunk.",
    runs([(10.0, 0.0), (10.0, 0.0), (10.0, 0.0), (10.0, 0.0)]),
    [
        seg("Jedna dva tři.", [("Jedna", 1.0, 2.0), ("dva", 12.0, 13.0), ("tři.", 25.0, 26.0)]),
        seg("Čtyři.", [("Čtyři.", 31.0, 32.0)]),
    ],
)

case(
    "split_at_one_second_gap",
    "Inside a chunk, a 0.5 s pause does not split and a pause of exactly 1 s does.",
    runs([(4.0, 0.5), (4.0, 1.0), (4.0, 0.0)]),
    [
        seg(
            "První věta. Druhá věta.",
            [
                ("První", 0.5, 1.0),
                ("věta.", 5.0, 6.0),
                ("Druhá", 10.0, 10.5),
                ("věta.", 11.0, 12.0),
            ],
        )
    ],
)

case(
    "long_pause_inside_chunk",
    "Speech on both sides of a 325 s pause shares one chunk but becomes two spans.",
    [(100.0, 106.0), (431.0, 451.0)],
    [
        seg(
            "Tady to končí. A tady začíná.",
            [
                ("Tady", 100.5, 101.0),
                ("to", 101.0, 101.3),
                ("končí.", 101.3, 102.0),
                ("A", 432.0, 432.2),
                ("tady", 432.2, 432.6),
                ("začíná.", 432.6, 433.4),
            ],
        )
    ],
)

case(
    "split_long_run_prefers_parts_within_30s",
    "Of two wide pauses, the run over 30 s is cut at the one that leaves both parts within 30 s.",
    runs([(2.0, 0.95)] + [(2.0, 0.5)] * 5 + [(2.0, 0.9)] + [(2.0, 0.5)] * 6 + [(2.0, 0.0)]),
    [seg("Slovo.", [("Slovo.", 0.2, 0.8)])],
)

case(
    "split_long_run_at_widest_gap",
    "Pauses under 1 s never split, so a run over 30 s is split at its widest pause, recursively.",
    runs([(2.0, 0.9)] * 6 + [(2.0, 0.95)] + [(2.0, 0.9)] * 6 + [(2.0, 0.0)]),
    [seg("Slovo.", [("Slovo.", 0.2, 0.8)])],
)

case(
    "split_long_run_equal_gaps_splits_evenly",
    "With all pauses equal, the run over 30 s is split into the most even parts instead of peeling off one region.",
    runs([(2.5, 0.8)] * 11 + [(2.5, 0.0)]),
    [seg("Slovo.", [("Slovo.", 0.2, 0.8)])],
)

case(
    "merge_short_across_shorter_gap",
    "A 0.8 s span joins the neighbour across the shorter pause (1.5 s before, 3 s after).",
    runs([(10.0, 1.5), (0.8, 3.0), (10.0, 0.0)]),
    [
        seg(
            "Tak jsme šli. A pak domů.",
            [
                ("Tak", 1.0, 1.4),
                ("jsme", 1.4, 1.8),
                ("šli.", 1.8, 2.4),
                ("A", 11.6, 12.2),
                ("pak", 16.0, 16.5),
                ("domů.", 16.5, 17.2),
            ],
        )
    ],
)

case(
    "merge_short_tie_prefers_previous",
    "With equal pauses on both sides, a short span joins the previous span.",
    runs([(10.0, 2.0), (0.8, 2.0), (10.0, 0.0)]),
    [seg("Ano.", [("Ano.", 12.1, 12.6)])],
)

case(
    "merge_short_refused_over_30s",
    "A short span stays alone when joining its only neighbour would pass 30 s.",
    runs([(28.5, 1.2), (0.9, 0.0)]),
    [seg("Dlouhá řeč. No.", [("Dlouhá", 1.0, 1.5), ("řeč.", 27.0, 28.0), ("No.", 29.8, 30.4)])],
)

case(
    "merge_short_falls_back_to_other_neighbour",
    "If the closer neighbour would pass 30 s, the short span joins the farther one.",
    runs([(2.2, 0.8)] * 9 + [(2.2, 1.1), (0.9, 1.6), (5.0, 0.0)]),
    [
        seg(
            "Dlouhá řeč. Tak. Konec.",
            [
                ("Dlouhá", 0.5, 1.0),
                ("řeč.", 28.0, 28.8),
                ("Tak.", 30.4, 31.0),
                ("Konec.", 33.5, 34.5),
            ],
        )
    ],
)

case(
    "short_spans_merge_repeatedly",
    "Several short spans in a row merge until each is at least 2 s or cannot grow.",
    runs([(0.5, 1.2), (0.5, 1.2), (0.5, 1.2), (6.0, 0.0)]),
    [
        seg(
            "A. B. C. Dlouhá věta.",
            [
                ("A.", 0.1, 0.4),
                ("B.", 1.8, 2.1),
                ("C.", 3.5, 3.8),
                ("Dlouhá", 5.0, 6.0),
                ("věta.", 6.0, 7.0),
            ],
        )
    ],
)

case(
    "word_in_removed_silence_goes_to_nearest_region",
    "A word whose midpoint lies in the pause between regions belongs to the nearest region.",
    runs([(5.0, 4.0), (5.0, 0.0)]),
    [
        seg(
            "Před pauzou. Hned po.",
            [("Před", 0.5, 1.0), ("pauzou.", 4.8, 5.6), ("Hned", 8.6, 9.2), ("po.", 9.5, 10.0)],
        )
    ],
)

case(
    "text_keeps_hyphen_spacing",
    "Span text is cut from the segment text, so 'ex-kidlo' keeps its spelling instead of the words joined by spaces.",
    [(0.0, 5.0)],
    [
        seg(
            "Já chci říkat ex-kidlo.",
            [
                ("Já", 0.1, 0.3),
                ("chci", 0.3, 0.6),
                ("říkat", 0.6, 1.0),
                ("ex", 1.0, 1.2),
                ("-kidlo.", 1.2, 1.8),
            ],
        )
    ],
)

case(
    "text_cut_at_first_word_of_each_span",
    "Leading punctuation goes with the first span; each later span starts at its first word.",
    runs([(4.0, 2.0), (4.0, 0.0)]),
    [
        seg(
            "„Pojď sem,“ řekl. Pak odešel.",
            [
                ("„Pojď", 0.2, 0.6),
                ("sem,“", 0.6, 1.0),
                ("řekl.", 1.2, 1.8),
                ("Pak", 6.2, 6.6),
                ("odešel.", 6.6, 7.4),
            ],
        )
    ],
)

case(
    "words_not_found_fall_back_to_joined_words",
    "When the words cannot be found in the segment text in order, each span gets its words joined by spaces.",
    runs([(4.0, 2.0), (4.0, 0.0)]),
    [
        seg(
            "Úplně jiný text.",
            [("Tady", 0.5, 1.0), ("je", 1.0, 1.3), ("něco", 6.5, 7.0), ("jiného.", 7.0, 7.6)],
        )
    ],
)

case(
    "text_without_words_goes_to_first_span",
    "A segment with text but no words puts its text into the chunk's first span.",
    runs([(4.0, 2.0), (4.0, 0.0)]),
    [seg("Bez časů slov.", [])],
)

case(
    "empty_segment",
    "A segment with no text and no words gives spans with empty text.",
    runs([(4.0, 2.0), (4.0, 0.0)]),
    [seg("", [])],
)

case(
    "two_chunks_spans_never_cross",
    "Spans stay inside their chunk even when the pause between chunks is short.",
    runs([(14.0, 0.2), (14.0, 0.2), (14.0, 0.0)]),
    [
        seg("První blok.", [("První", 1.0, 2.0), ("blok.", 20.0, 21.0)]),
        seg("Druhý blok.", [("Druhý", 29.0, 30.0), ("blok.", 38.0, 39.0)]),
    ],
)

cases.append(
    {
        "name": "refuse_without_regions",
        "why": "A source without clip_timestamps cannot be segmented, so correction must not start from it.",
        "transcript": {
            "meta": {"generation_params": {"transcription_options": {}}},
            "segments": [seg("Text.", [])],
        },
    }
)
cases.append(
    {
        "name": "refuse_chunk_mismatch",
        "why": "A source whose regions rebuild into a different number of chunks than it has segments is refused.",
        "transcript": transcript(runs([(10.0, 0.0)] * 4), [seg("Jen jeden segment.", [])]),
    }
)

real = None
if len(sys.argv) > 1:
    real = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
elif CONTRACT_PATH.exists():
    previous = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    real = next(
        (c["transcript"] for c in previous["cases"] if c["name"] == "production_timing"), None
    )
if real is not None:
    cases.append(
        {
            "name": "production_timing",
            "why": "Region and word timing from the start of a production transcript, with placeholder words, to keep both ports exact on real floats.",
            "transcript": real,
        }
    )

for c in cases:
    try:
        result = cs.segment_transcript(c["transcript"])
        c["expected"] = {
            "chunkCount": result.chunk_count,
            "spans": [cs.span_to_contract(sp) for sp in result.spans],
        }
    except cs.SegmentationError as exc:
        c["expected"] = {"error": exc.code}

doc = {
    "description": (
        "Correction spans cut from decoded VAD chunks (ADR 0012). besedy/lib/correction_segmentation.py "
        "and web/src/lib/correction/segmentation.ts must both turn every case's transcript into its "
        "expected output; tests/test_correction_segmentation.py and "
        "web/tests/unit/correction-segmentation-contract.test.ts check that. Change all three together "
        "and bump the version when the output changes."
    ),
    "version": cs.SEGMENTATION_VERSION,
    "params": {
        "sampleRate": cs.SAMPLE_RATE,
        "maxChunkSpeechSamples": cs.MAX_CHUNK_SPEECH_SAMPLES,
        "splitGapSamples": cs.SPLIT_GAP_SAMPLES,
        "maxSpanSamples": cs.MAX_SPAN_SAMPLES,
        "mergeBelowSamples": cs.MERGE_BELOW_SAMPLES,
    },
    "normalization": [
        {"input": raw, "expected": cs.normalize_span_text(raw), "why": why}
        for raw, why in [
            ("  Dobrý   den.  ", "Leading, trailing and repeated spaces collapse."),
            ("a\r\nb\rc\nd", "Line breaks of every kind become one space."),
            (
                "a" + chr(0xA0) + chr(0x200B) + " b",
                "No-break and zero-width spaces count as whitespace.",
            ),
            (
                "a" + chr(0xFEFF) + "b" + chr(0x180E) + "c",
                "BOM and Mongolian vowel separator count as whitespace.",
            ),
            (
                "a" + chr(0x3000) + "b" + chr(0x2028) + "c",
                "Ideographic space and line separator count as whitespace.",
            ),
            (
                "a" + chr(0x85) + "b" + chr(0x1C) + "c",
                "NEL and information separators stay: JavaScript does not treat them as whitespace.",
            ),
            (
                chr(0x85) + " a " + chr(0x85),
                "NEL stays at the ends too: trimming removes only what JavaScript trims.",
            ),
            (
                "e" + chr(0x30C) + "sky",
                "Text is composed to NFC (e + combining caron becomes one letter).",
            ),
        ]
    ],
    "cases": cases,
}
text = json.dumps(doc, ensure_ascii=False, indent=2)
# Keep invisible characters visible as JSON escapes.
text = "".join(
    ch
    if ch in "\n"
    or (
        32 <= ord(ch)
        and ord(ch) not in (0x85, 0xA0, 0x180E, 0x2028, 0x2029, 0x3000, 0xFEFF)
        and not 0x2000 <= ord(ch) <= 0x200B
    )
    else "\\u%04x" % ord(ch)
    for ch in text
)
with open(CONTRACT_PATH, "w", encoding="utf-8") as f:
    f.write(text + "\n")
print(len(cases), "cases")
for c in cases:
    e = c["expected"]
    print(
        f"{c['name']}: "
        + (
            e["error"]
            if "error" in e
            else f"{e['chunkCount']} chunks, "
            + " | ".join(
                f"c{sp['chunk']} r{sp['firstRegion']}-{sp['lastRegion']} {(sp['endSample'] - sp['startSample']) / SR:.2f}s w{sp['wordIndices']} {sp['text']!r}"
                for sp in e["spans"]
            )
        )
    )
