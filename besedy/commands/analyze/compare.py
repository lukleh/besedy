"""Cross-model comparison focused on disagreement hotspots."""

from __future__ import annotations

import json
from difflib import SequenceMatcher
from statistics import mean
from typing import Any

from besedy.lib.analysis.comparison import (
    build_interval_comparisons,
    compare_transcripts,
    normalize_text,
)

from .common import extract_segments, group_by_audio_hash, load_transcript_records


def _pairwise_similarity(transcripts: dict[str, list]) -> list[dict[str, Any]]:
    model_keys = sorted(transcripts.keys())
    by_model_text = {
        key: normalize_text(" ".join(seg.text for seg in transcripts[key] if seg.text))
        for key in model_keys
    }

    rows: list[dict[str, Any]] = []
    for idx, model_a in enumerate(model_keys):
        for model_b in model_keys[idx + 1 :]:
            ratio = SequenceMatcher(None, by_model_text[model_a], by_model_text[model_b]).ratio()
            rows.append(
                {
                    "model_a": model_a,
                    "model_b": model_b,
                    "text_similarity": round(ratio, 4),
                }
            )
    return rows


def cmd_compare(
    *,
    transcripts_root=None,
    backend_filter: list[str] | None = None,
    hash_filter: list[str] | None = None,
    limit: int | None = None,
    min_models: int = 2,
    output_format: str = "text",
    return_data: bool = False,
) -> int | dict[str, Any]:
    """Compare transcripts between models for the same audio hash."""

    root, records, load_errors = load_transcript_records(
        transcripts_root=transcripts_root,
        backend_filter=backend_filter,
        hash_filter=hash_filter,
        limit=limit,
    )

    grouped = group_by_audio_hash(records)
    compared: list[dict[str, Any]] = []

    for audio_hash in sorted(grouped.keys()):
        rows = grouped[audio_hash]

        transcript_map: dict[str, list] = {}
        for row in rows:
            segments = extract_segments(row)
            if not segments:
                continue
            transcript_map[row.model_key] = segments

        if len(transcript_map) < min_models:
            continue

        result = compare_transcripts(transcript_map, audio_hash, sample_limit=8)
        pairwise = _pairwise_similarity(transcript_map)

        intervals = build_interval_comparisons(transcript_map)
        hotspots: list[dict[str, Any]] = []
        for interval in intervals:
            normalized = {
                model_key: normalize_text(text)
                for model_key, text in interval.texts.items()
                if text.strip()
            }
            unique = {value for value in normalized.values() if value}
            if len(unique) <= 1:
                continue

            hotspots.append(
                {
                    "start": round(interval.start, 3),
                    "end": round(interval.end, 3),
                    "duration_seconds": round(interval.duration, 3),
                    "texts": interval.texts,
                }
            )

        hotspots.sort(key=lambda item: item["duration_seconds"], reverse=True)

        total_intervals = result.agreements + result.disagreements
        agreement_ratio = (result.agreements / total_intervals) if total_intervals else 1.0

        compared.append(
            {
                "audio_hash": audio_hash,
                "models": sorted(transcript_map.keys()),
                "coverage_seconds": {
                    key: round(value, 3) for key, value in result.coverage_seconds.items()
                },
                "overlap_seconds_all": round(result.overlap_seconds_all, 3),
                "agreement_intervals": result.agreements,
                "disagreement_intervals": result.disagreements,
                "agreement_ratio": round(agreement_ratio, 4),
                "pairwise_similarity": pairwise,
                "disagreement_hotspots": hotspots[:10],
                "disagreement_samples": [
                    {
                        "start": round(start, 3),
                        "end": round(end, 3),
                        "texts": texts,
                    }
                    for start, end, texts in result.disagreement_samples
                ],
            }
        )

    similarity_values = [
        item["text_similarity"] for row in compared for item in row["pairwise_similarity"]
    ]
    avg_similarity = mean(similarity_values) if similarity_values else 0.0

    payload: dict[str, Any] = {
        "transcripts_root": str(root),
        "summary": {
            "audio_hashes_compared": len(compared),
            "min_models": min_models,
            "load_errors": len(load_errors),
            "average_pairwise_similarity": round(avg_similarity, 4),
        },
        "comparisons": compared,
        "load_errors": load_errors,
    }

    if return_data:
        return payload

    if output_format == "json":
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    summary = payload["summary"]
    print("Cross-model comparison")
    print(f"Root: {payload['transcripts_root']}")
    print(
        "Compared "
        f"{summary['audio_hashes_compared']} audio hashes "
        f"(avg pairwise similarity={summary['average_pairwise_similarity']:.3f})"
    )

    if summary["load_errors"]:
        print(f"Load errors: {summary['load_errors']}")

    for row in compared[:20]:
        pairwise = row["pairwise_similarity"]
        avg_local = mean(item["text_similarity"] for item in pairwise) if pairwise else 1.0
        print(
            f"  {row['audio_hash'][:12]} models={len(row['models'])} "
            f"agreement={row['agreement_ratio']:.2%} similarity={avg_local:.3f} "
            f"hotspots={len(row['disagreement_hotspots'])}"
        )

    return 0


__all__ = ["cmd_compare"]
