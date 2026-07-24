"""Suggest patch candidates for repetitive transcript spans using other models."""

from __future__ import annotations

import json
from difflib import SequenceMatcher
from statistics import mean
from typing import Any

from besedy.lib.analysis.repetition import find_word_repeats

from .common import (
    extract_segments,
    group_by_audio_hash,
    load_transcript_records,
    overlap_ratio,
    span_text,
)
from .repetition import _merge_spans


def _text_repetition_score(text: str, *, min_repeats: int) -> float:
    if not text.strip():
        return 0.0
    findings = find_word_repeats(text, min_repeats=min_repeats)
    return float(sum(f.repeats * max(1, f.length) for f in findings))


def _candidate_confidence(quality: float, improvement: float, overlap: float) -> str:
    if quality >= 0.8 and improvement >= 2 and overlap >= 0.8:
        return "high"
    if quality >= 0.6 and overlap >= 0.6:
        return "medium"
    return "low"


def cmd_patch_candidates(
    *,
    transcripts_root=None,
    backend_filter: list[str] | None = None,
    hash_filter: list[str] | None = None,
    limit: int | None = None,
    min_models: int = 2,
    min_repeats: int = 2,
    min_overlap: float = 0.5,
    output_format: str = "text",
    return_data: bool = False,
) -> int | dict[str, Any]:
    """Find replacement candidates for repetitive spans across models."""

    root, records, load_errors = load_transcript_records(
        transcripts_root=transcripts_root,
        backend_filter=backend_filter,
        hash_filter=hash_filter,
        limit=limit,
    )

    grouped = group_by_audio_hash(records)
    suggestions: list[dict[str, Any]] = []

    for audio_hash, rows in sorted(grouped.items()):
        by_model_segments: dict[str, list] = {row.model_key: extract_segments(row) for row in rows}
        by_model_segments = {
            model_key: segments for model_key, segments in by_model_segments.items() if segments
        }
        if len(by_model_segments) < min_models:
            continue

        for source_model, source_segments in sorted(by_model_segments.items()):
            repeated_spans_raw: list[tuple[float, float]] = []
            for seg_idx in range(len(source_segments) - 1):
                a = source_segments[seg_idx]
                b = source_segments[seg_idx + 1]
                if not a.text or not b.text:
                    continue
                if a.text.strip().lower() == b.text.strip().lower():
                    repeated_spans_raw.append((a.start, b.end))

            repeated_spans = _merge_spans(repeated_spans_raw)
            if not repeated_spans:
                continue

            for span_start, span_end in repeated_spans:
                original_text = span_text(source_segments, span_start, span_end)
                source_rep_score = _text_repetition_score(original_text, min_repeats=min_repeats)

                if source_rep_score <= 0:
                    continue

                candidate_rows: list[dict[str, Any]] = []
                for candidate_model, candidate_segments in by_model_segments.items():
                    if candidate_model == source_model:
                        continue

                    candidate_text = span_text(candidate_segments, span_start, span_end)
                    if not candidate_text:
                        continue

                    span_overlap = overlap_ratio(candidate_segments, span_start, span_end)
                    if span_overlap < min_overlap:
                        continue

                    candidate_rep_score = _text_repetition_score(
                        candidate_text,
                        min_repeats=min_repeats,
                    )
                    improvement = source_rep_score - candidate_rep_score

                    other_texts = [
                        span_text(other_segments, span_start, span_end)
                        for other_model, other_segments in by_model_segments.items()
                        if other_model not in {source_model, candidate_model}
                    ]
                    other_texts = [text for text in other_texts if text]
                    if other_texts:
                        agreement = mean(
                            SequenceMatcher(None, candidate_text, other_text).ratio()
                            for other_text in other_texts
                        )
                    else:
                        agreement = 0.5

                    quality = (
                        0.6 * span_overlap
                        + 0.3 * agreement
                        + 0.1 * max(0.0, min(improvement / 10.0, 1.0))
                    )

                    candidate_rows.append(
                        {
                            "replacement_model": candidate_model,
                            "replacement_text": candidate_text,
                            "overlap_ratio": round(span_overlap, 4),
                            "agreement_score": round(agreement, 4),
                            "source_repetition_score": round(source_rep_score, 4),
                            "replacement_repetition_score": round(candidate_rep_score, 4),
                            "improvement": round(improvement, 4),
                            "quality": round(quality, 4),
                        }
                    )

                if not candidate_rows:
                    continue

                candidate_rows.sort(key=lambda row: row["quality"], reverse=True)
                best = candidate_rows[0]

                # Keep only actionable candidates by default.
                if best["improvement"] <= 0:
                    continue

                suggestions.append(
                    {
                        "audio_hash": audio_hash,
                        "source_model": source_model,
                        "span_start": round(span_start, 3),
                        "span_end": round(span_end, 3),
                        "span_duration": round(span_end - span_start, 3),
                        "source_text": original_text,
                        "best_candidate": {
                            **best,
                            "confidence": _candidate_confidence(
                                best["quality"],
                                best["improvement"],
                                best["overlap_ratio"],
                            ),
                        },
                        "alternatives": candidate_rows[1:3],
                    }
                )

    suggestions.sort(
        key=lambda row: (
            row["best_candidate"]["quality"],
            row["best_candidate"]["improvement"],
        ),
        reverse=True,
    )

    payload: dict[str, Any] = {
        "transcripts_root": str(root),
        "summary": {
            "total_suggestions": len(suggestions),
            "audio_hashes_with_suggestions": len({row["audio_hash"] for row in suggestions}),
            "load_errors": len(load_errors),
            "min_models": min_models,
            "min_repeats": min_repeats,
            "min_overlap": min_overlap,
        },
        "suggestions": suggestions,
        "load_errors": load_errors,
    }

    if return_data:
        return payload

    if output_format == "json":
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    summary = payload["summary"]
    print("Patch candidate suggestions")
    print(f"Root: {payload['transcripts_root']}")
    print(
        f"Suggestions: {summary['total_suggestions']} across "
        f"{summary['audio_hashes_with_suggestions']} audio hashes"
    )

    if summary["load_errors"]:
        print(f"Load errors: {summary['load_errors']}")

    for row in suggestions[:20]:
        best = row["best_candidate"]
        print(
            f"  {row['audio_hash'][:12]} {row['source_model']} -> {best['replacement_model']} "
            f"[{row['span_start']:.2f}-{row['span_end']:.2f}s] "
            f"quality={best['quality']:.2f} confidence={best['confidence']}"
        )

    return 0


__all__ = ["cmd_patch_candidates"]
