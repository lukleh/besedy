"""Correction spans cut from the chunks a transcript was decoded in (ADR 0012).

faster-whisper's batched mode packs consecutive VAD regions into model inputs
of at most 30 s of speech and decodes each pack ("chunk") into one transcript
segment. The regions are stored in the transcript as
``meta.generation_params.transcription_options.clip_timestamps``, so the chunks
can be rebuilt exactly with the same rule as ``faster_whisper.vad.collect_chunks``
(faster-whisper 1.2.1).

A correction span is a run of consecutive regions inside one chunk:

1. each chunk is split wherever the silence between two regions is at least
   1 s;
2. a run still longer than 30 s, first region start to last region end, is
   split at its longest internal gap, recursively;
3. a run shorter than 2 s is merged into its neighbour in the same chunk,
   across the shorter gap first, when the merged run stays within 30 s.

A span never crosses a chunk boundary, so the texts of a chunk's spans, in
order, are the label for exactly the audio the model was given.

The web application imports workspaces with a TypeScript port of this module
(``web/src/lib/correction/segmentation.ts``). Both are checked against the
shared cases in ``contracts/correction-segmentation.json``; change the three
together, and bump ``SEGMENTATION_VERSION`` when the output changes.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

SEGMENTATION_VERSION = "chunks-v1"
SAMPLE_RATE = 16000
MAX_CHUNK_SPEECH_SAMPLES = 30 * SAMPLE_RATE
SPLIT_GAP_SAMPLES = 1 * SAMPLE_RATE
MAX_SPAN_SAMPLES = 30 * SAMPLE_RATE
MERGE_BELOW_SAMPLES = 2 * SAMPLE_RATE

# JavaScript's \s plus the extra characters web/src/lib/correction/text.ts
# collapses. Python's own \s differs (it includes \x1c-\x1f and \x85, and
# lacks \ufeff), so the class is spelled out to normalize exactly as the web.
_WHITESPACE = re.compile(
    "[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u180e\u200b]+"
)


class SegmentationError(ValueError):
    """The source cannot be segmented; correction must not start from it."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Region:
    """One VAD region in samples of the staged 16 kHz audio."""

    start: int
    end: int


@dataclass(frozen=True)
class Span:
    chunk: int
    first_region: int
    last_region: int
    start_sample: int
    end_sample: int
    regions: tuple[Region, ...]
    word_indices: tuple[int, ...]
    text: str

    @property
    def start_seconds(self) -> float:
        return self.start_sample / SAMPLE_RATE

    @property
    def end_seconds(self) -> float:
        return self.end_sample / SAMPLE_RATE


@dataclass(frozen=True)
class Segmentation:
    version: str
    chunk_count: int
    spans: tuple[Span, ...]
    params: dict[str, int] = field(
        default_factory=lambda: {
            "sampleRate": SAMPLE_RATE,
            "maxChunkSpeechSamples": MAX_CHUNK_SPEECH_SAMPLES,
            "splitGapSamples": SPLIT_GAP_SAMPLES,
            "maxSpanSamples": MAX_SPAN_SAMPLES,
            "mergeBelowSamples": MERGE_BELOW_SAMPLES,
        }
    )


def normalize_span_text(raw: str) -> str:
    """Normalize text exactly as ``normalizeSpanText`` in the web application."""
    text = unicodedata.normalize("NFC", raw)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # Every JavaScript whitespace character is a space by now, so trimming
    # spaces matches String.prototype.trim; str.strip() would also remove
    # characters such as \x85 that JavaScript keeps.
    return _WHITESPACE.sub(" ", text).strip(" ")


def build_chunks(regions: Sequence[Region]) -> list[list[int]]:
    """Group region indices as ``faster_whisper.vad.collect_chunks`` does.

    The rule only adds up speech: the silence between regions, however long,
    does not count. An empty input gives one empty chunk, as faster-whisper's.
    """
    chunks: list[list[int]] = []
    current: list[int] = []
    duration = 0
    for index, region in enumerate(regions):
        length = region.end - region.start
        if duration + length > MAX_CHUNK_SPEECH_SAMPLES:
            chunks.append(current)
            current = []
            duration = 0
        current.append(index)
        duration += length
    chunks.append(current)
    return chunks


def _window(regions: Sequence[Region], run: Sequence[int]) -> int:
    return regions[run[-1]].end - regions[run[0]].start


def _gap(regions: Sequence[Region], left: int, right: int) -> int:
    return regions[right].start - regions[left].end


def _split_long(regions: Sequence[Region], run: list[int]) -> list[list[int]]:
    """Split a run over 30 s between two regions, recursively.

    Every region boundary lies in a pause (VAD pads and bridges speech), so any
    of them may be cut. The cut prefers, in order: leaving both parts within
    30 s, the widest pause, the most even parts, the earliest position. Taking
    the widest pause alone would peel short pieces off one end when the
    pauses are alike.
    """
    if len(run) == 1 or _window(regions, run) <= MAX_SPAN_SAMPLES:
        return [run]
    cut, best = 1, None
    for i in range(1, len(run)):
        left, right = _window(regions, run[:i]), _window(regions, run[i:])
        # Compared as a tuple, so the bool sorts False < True exactly as the
        # TypeScript port's `1 : 0` first key; the later keys are plain ints.
        key = (
            left <= MAX_SPAN_SAMPLES and right <= MAX_SPAN_SAMPLES,
            _gap(regions, run[i - 1], run[i]),
            -abs(left - right),
            -i,
        )
        if best is None or key > best:
            cut, best = i, key
    return _split_long(regions, run[:cut]) + _split_long(regions, run[cut:])


def _merge_short(regions: Sequence[Region], runs: list[list[int]]) -> list[list[int]]:
    runs = [list(run) for run in runs]
    changed = True
    while changed and len(runs) > 1:
        changed = False
        for i, run in enumerate(runs):
            if _window(regions, run) >= MERGE_BELOW_SAMPLES:
                continue
            # (gap, side, neighbour): the shorter gap first, the previous neighbour on ties
            options: list[tuple[int, int, int]] = []
            if i > 0:
                options.append((_gap(regions, runs[i - 1][-1], run[0]), 0, i - 1))
            if i + 1 < len(runs):
                options.append((_gap(regions, run[-1], runs[i + 1][0]), 1, i + 1))
            for _, _, j in sorted(options):
                low = min(i, j)
                merged = runs[low] + runs[low + 1]
                if _window(regions, merged) <= MAX_SPAN_SAMPLES:
                    runs[low : low + 2] = [merged]
                    changed = True
                    break
            if changed:
                break
    return runs


def split_chunk(regions: Sequence[Region], chunk: Sequence[int]) -> list[list[int]]:
    """Cut one chunk's region indices into correction runs."""
    if not chunk:
        return []
    runs: list[list[int]] = []
    current = [chunk[0]]
    for previous, index in zip(chunk, chunk[1:]):
        if _gap(regions, previous, index) >= SPLIT_GAP_SAMPLES:
            runs.append(current)
            current = []
        current.append(index)
    runs.append(current)
    split = [piece for run in runs for piece in _split_long(regions, run)]
    return _merge_short(regions, split)


def _seconds(value: Any, fallback: float) -> float:
    """A word time: a finite JSON number, otherwise the fallback (as on the web)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    return float(value) if math.isfinite(value) else fallback


def _region_of_word(
    regions: Sequence[Region], chunk: Sequence[int], word: Mapping[str, Any]
) -> int:
    """The chunk region holding the word's midpoint, else the nearest one."""
    start = _seconds(word.get("start"), 0.0) or 0.0
    end = _seconds(word.get("end"), start)
    middle = (start + end) / 2
    best, best_distance = chunk[0], None
    for index in chunk:
        lo = regions[index].start / SAMPLE_RATE
        hi = regions[index].end / SAMPLE_RATE
        if lo <= middle <= hi:
            return index
        distance = lo - middle if middle < lo else middle - hi
        if best_distance is None or distance < best_distance:
            best, best_distance = index, distance
    return best


def _span_texts(
    text: str, words: Sequence[Mapping[str, Any]], owner: Sequence[int], span_count: int
) -> list[str]:
    """Cut the segment text at the first word of each span.

    Words are located in the segment text in order. Text before the first word
    goes with the first span that has words, and everything up to the next
    span's first word with the span before it, so no character of the segment
    text is lost. If the words cannot be located in order, the spans fall back
    to their words joined by spaces.
    """
    tokens = [normalize_span_text(_string(w.get("word"))) for w in words]
    fallback = [
        normalize_span_text(" ".join(t for t, o in zip(tokens, owner) if o == s and t))
        for s in range(span_count)
    ]
    starts: dict[int, int] = {}
    cursor = 0
    last_span = -1
    for token, span in zip(tokens, owner):
        if not token:
            continue
        found = text.find(token, cursor)
        if found < 0 or span < last_span:
            return fallback
        if span not in starts:
            starts[span] = found
        cursor = found + len(token)
        last_span = span
    if not starts:
        texts = [""] * span_count
        if span_count and normalize_span_text(text):
            texts[0] = normalize_span_text(text)
        return texts
    ordered = sorted(starts)
    texts = [""] * span_count
    for k, span in enumerate(ordered):
        lo = 0 if k == 0 else starts[span]
        hi = starts[ordered[k + 1]] if k + 1 < len(ordered) else len(text)
        texts[span] = normalize_span_text(text[lo:hi])
    return texts


def _string(value: Any) -> str:
    """A JSON string; anything else is an empty string, as on the web."""
    return value if isinstance(value, str) else ""


def _sample(value: Any) -> int:
    """A sample offset; JSON numbers only, and only whole ones, as on the web."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(value)
    if not float(value).is_integer():
        raise ValueError(value)
    return int(value)


def _mapping(value: Any) -> Mapping[str, Any]:
    """A JSON object; anything else reads as empty, as on the web."""
    return value if isinstance(value, Mapping) else {}


def _regions_of(transcript: Mapping[str, Any]) -> list[Region]:
    meta = _mapping(transcript.get("meta"))
    params = _mapping(meta.get("generation_params"))
    options = _mapping(params.get("transcription_options"))
    clips = options.get("clip_timestamps")
    if not isinstance(clips, list) or not clips:
        raise SegmentationError(
            "NO_REGIONS", "The source transcript records no VAD regions (clip_timestamps)"
        )
    regions = []
    for clip in clips:
        try:
            regions.append(Region(_sample(clip["start"]), _sample(clip["end"])))
        except (KeyError, TypeError, ValueError) as exc:
            raise SegmentationError(
                "NO_REGIONS", f"Malformed clip_timestamps entry: {clip!r}"
            ) from exc
    # Regions are read in audio order; two may touch but never overlap or
    # go backwards, and each holds some speech. Anything else is not VAD
    # output, and the chunk and span arithmetic would be meaningless on it.
    previous_end = 0
    for index, region in enumerate(regions):
        if region.start < previous_end or region.end <= region.start:
            raise SegmentationError(
                "NO_REGIONS",
                "Malformed clip_timestamps: regions must be ordered and non-empty "
                f"(region {index} spans samples {region.start}-{region.end})",
            )
        previous_end = region.end
    return regions


def segment_transcript(transcript: Mapping[str, Any]) -> Segmentation:
    """Correction spans for one canonical ``transcript.json`` document."""
    regions = _regions_of(transcript)
    raw_segments = transcript.get("segments")
    segments = raw_segments if isinstance(raw_segments, list) else []
    chunks = build_chunks(regions)
    if len(chunks) != len(segments) or any(not chunk for chunk in chunks):
        raise SegmentationError(
            "CHUNK_MISMATCH",
            f"The source has {len(segments)} segments but its VAD regions rebuild into {len(chunks)} chunks",
        )

    spans: list[Span] = []
    for chunk_index, (chunk, segment) in enumerate(zip(chunks, segments)):
        if not isinstance(segment, Mapping):
            segment = {}
        runs = split_chunk(regions, chunk)
        run_of_region = {region: r for r, run in enumerate(runs) for region in run}
        words = [w for w in (segment.get("words") or []) if isinstance(w, Mapping)]
        owner = [run_of_region[_region_of_word(regions, chunk, w)] for w in words]
        texts = _span_texts(_string(segment.get("text")), words, owner, len(runs))
        for r, run in enumerate(runs):
            spans.append(
                Span(
                    chunk=chunk_index,
                    first_region=run[0],
                    last_region=run[-1],
                    start_sample=regions[run[0]].start,
                    end_sample=regions[run[-1]].end,
                    regions=tuple(regions[i] for i in run),
                    word_indices=tuple(i for i, o in enumerate(owner) if o == r),
                    text=texts[r],
                )
            )
    return Segmentation(version=SEGMENTATION_VERSION, chunk_count=len(chunks), spans=tuple(spans))


def span_to_contract(span: Span) -> dict[str, Any]:
    """The span fields the shared contract cases compare."""
    return {
        "chunk": span.chunk,
        "firstRegion": span.first_region,
        "lastRegion": span.last_region,
        "startSample": span.start_sample,
        "endSample": span.end_sample,
        "wordIndices": list(span.word_indices),
        "text": span.text,
    }
