"""Transcript repetition checks (JSON-first)."""

from __future__ import annotations

import json
from collections import Counter
from typing import Any, TypedDict

from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

from besedy.lib.analysis.repetition import RepeatFinding, detect_all_repetitions

from .common import TranscriptRecord, coerce_float, load_transcript_records, transcript_duration


class OverlapEvent(TypedDict):
    start: float
    end: float
    models: set[str]


class OverlapCluster(OverlapEvent):
    pair_matches: int


def _finding_payload(finding: RepeatFinding) -> dict[str, Any]:
    return {
        "kind": finding.kind,
        "length": finding.length,
        "repeats": finding.repeats,
        "start_index": finding.start_index,
        "sequence": finding.sequence,
        "snippet": finding.snippet,
        "char_start": finding.char_start,
        "char_end": finding.char_end,
        "segment_start": finding.segment_start,
        "segment_end": finding.segment_end,
        "start_time": finding.start_time,
        "end_time": finding.end_time,
    }


def _merge_spans(spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
    if not spans:
        return []
    spans.sort()
    merged: list[tuple[float, float]] = []
    start, end = spans[0]
    for cur_start, cur_end in spans[1:]:
        if cur_start <= end + 1e-3:
            end = max(end, cur_end)
            continue
        merged.append((start, end))
        start, end = cur_start, cur_end
    merged.append((start, end))
    return merged


def _severity(score: float, coverage: float | None) -> str:
    if score == 0:
        return "none"
    if coverage is None:
        if score >= 3000:
            return "high"
        if score >= 1000:
            return "medium"
        return "low"

    # Coverage is primary; score modulates borderline cases.
    if coverage >= 0.08:
        return "high"
    if coverage >= 0.03:
        return "high" if score >= 2000 else "medium"
    if coverage >= 0.015:
        return "medium" if score >= 500 else "low"
    if coverage >= 0.005:
        return "medium" if score >= 1500 else "low"
    return "medium" if score >= 3500 else "low"


def _finding_impact(finding: RepeatFinding) -> float:
    """Return weighted impact for a single finding."""
    return float(finding.repeats * max(1, finding.length))


def _span_overlap_ratio(
    a_start: float,
    a_end: float,
    b_start: float,
    b_end: float,
) -> float:
    """Return overlap ratio over the shorter span."""
    intersection = max(0.0, min(a_end, b_end) - max(a_start, b_start))
    if intersection <= 0:
        return 0.0

    a_len = max(0.0, a_end - a_start)
    b_len = max(0.0, b_end - b_start)
    shorter = min(a_len, b_len)
    if shorter <= 0:
        return 0.0
    return intersection / shorter


def _char_span(finding: RepeatFinding) -> tuple[float, float] | None:
    start = float(finding.char_start)
    end = float(finding.char_end)
    if end <= start:
        return None
    return start, end


def _segment_span(finding: RepeatFinding) -> tuple[float, float] | None:
    if finding.segment_start is not None and finding.segment_end is not None:
        start = float(finding.segment_start)
        end = float(finding.segment_end + 1)
        if end > start:
            return start, end

    start_time = coerce_float(finding.start_time)
    end_time = coerce_float(finding.end_time)
    if start_time is None or end_time is None or end_time <= start_time:
        return None
    return start_time, end_time


def _select_distinct_findings(
    findings: list[RepeatFinding],
    *,
    span_extractor,
    overlap_threshold: float = 0.8,
) -> list[RepeatFinding]:
    """Greedily keep high-impact findings while suppressing near-duplicates."""
    selected: list[RepeatFinding] = []
    selected_spans: list[tuple[float, float]] = []

    for finding in sorted(findings, key=_finding_impact, reverse=True):
        span = span_extractor(finding)
        if span is None:
            selected.append(finding)
            continue

        start, end = span
        is_duplicate = any(
            _span_overlap_ratio(start, end, other_start, other_end) >= overlap_threshold
            for other_start, other_end in selected_spans
        )
        if is_duplicate:
            continue

        selected.append(finding)
        selected_spans.append((start, end))

    return selected


def _char_spans_to_time_spans(
    char_spans: list[tuple[int, int]],
    segments: list[dict[str, Any]],
) -> list[tuple[float, float]]:
    """Project global transcript char spans into timeline spans.

    Assumes segment text is concatenated with newline separators, matching
    detect_all_repetitions() full-text construction.
    """
    if not char_spans or not segments:
        return []

    segment_char_ranges: list[tuple[int, int, float, float]] = []
    char_offset = 0

    for segment in segments:
        text = str(segment.get("text", ""))
        seg_char_start = char_offset
        seg_char_end = seg_char_start + len(text)

        start_time = coerce_float(segment.get("start"))
        end_time = coerce_float(segment.get("end"))
        if (
            seg_char_end > seg_char_start
            and start_time is not None
            and end_time is not None
            and end_time > start_time
        ):
            segment_char_ranges.append((seg_char_start, seg_char_end, start_time, end_time))

        # detect_all_repetitions joins segment text with "\n"
        char_offset = seg_char_end + 1

    if not segment_char_ranges:
        return []

    spans: list[tuple[float, float]] = []
    for span_start, span_end in char_spans:
        if span_end <= span_start:
            continue

        for seg_char_start, seg_char_end, seg_start_time, seg_end_time in segment_char_ranges:
            overlap_start = max(span_start, seg_char_start)
            overlap_end = min(span_end, seg_char_end)
            if overlap_end <= overlap_start:
                continue

            segment_char_len = seg_char_end - seg_char_start
            segment_duration = seg_end_time - seg_start_time
            rel_start = (overlap_start - seg_char_start) / segment_char_len
            rel_end = (overlap_end - seg_char_start) / segment_char_len
            time_start = seg_start_time + rel_start * segment_duration
            time_end = seg_start_time + rel_end * segment_duration
            if time_end > time_start:
                spans.append((time_start, time_end))

    return spans


def _pairwise_overlap_events(
    model_spans: dict[str, list[tuple[float, float]]],
    *,
    tolerance_seconds: float,
) -> list[OverlapEvent]:
    """Return pairwise overlap/near-overlap events between models."""
    events: list[OverlapEvent] = []
    model_keys = sorted(model_spans)

    for idx, model_a in enumerate(model_keys):
        spans_a = model_spans[model_a]
        for model_b in model_keys[idx + 1 :]:
            spans_b = model_spans[model_b]
            ia = 0
            ib = 0

            while ia < len(spans_a) and ib < len(spans_b):
                a_start, a_end = spans_a[ia]
                b_start, b_end = spans_b[ib]

                event_start: float | None = None
                event_end: float | None = None

                overlap_start = max(a_start, b_start)
                overlap_end = min(a_end, b_end)
                if overlap_end > overlap_start:
                    event_start = overlap_start
                    event_end = overlap_end
                else:
                    center_a = (a_start + a_end) / 2.0
                    center_b = (b_start + b_end) / 2.0
                    duration_a = max(0.0, a_end - a_start)
                    duration_b = max(0.0, b_end - b_start)
                    shorter = max(min(duration_a, duration_b), 1e-6)
                    longer = max(duration_a, duration_b)
                    duration_ratio = longer / shorter

                    if abs(center_a - center_b) <= tolerance_seconds and duration_ratio <= 3.0:
                        event_start = max(a_start - tolerance_seconds, b_start - tolerance_seconds)
                        event_end = min(a_end + tolerance_seconds, b_end + tolerance_seconds)
                        if event_end <= event_start:
                            event_start = min(a_start, b_start)
                            event_end = max(a_end, b_end)

                if event_start is not None and event_end is not None and event_end > event_start:
                    events.append(
                        {
                            "start": event_start,
                            "end": event_end,
                            "models": {model_a, model_b},
                        }
                    )

                if a_end <= b_end:
                    ia += 1
                else:
                    ib += 1

    return events


def _merge_overlap_events(
    events: list[OverlapEvent],
    *,
    tolerance_seconds: float,
    min_models: int,
) -> list[dict[str, Any]]:
    """Merge nearby overlap events into hotspot windows."""
    if not events:
        return []

    sorted_events = sorted(events, key=lambda row: (row["start"], row["end"]))
    merged: list[OverlapCluster] = []

    current: OverlapCluster = {
        "start": float(sorted_events[0]["start"]),
        "end": float(sorted_events[0]["end"]),
        "models": set(sorted_events[0]["models"]),
        "pair_matches": 1,
    }

    for event in sorted_events[1:]:
        event_start = float(event["start"])
        event_end = float(event["end"])
        if event_start <= current["end"] + tolerance_seconds:
            current["start"] = min(current["start"], event_start)
            current["end"] = max(current["end"], event_end)
            current["models"].update(event["models"])
            current["pair_matches"] += 1
            continue

        merged.append(current)
        current = {
            "start": event_start,
            "end": event_end,
            "models": set(event["models"]),
            "pair_matches": 1,
        }

    merged.append(current)

    hotspots: list[dict[str, Any]] = []
    for cluster in merged:
        models = sorted(cluster["models"])
        model_count = len(models)
        if model_count < min_models:
            continue
        duration_seconds = max(0.0, cluster["end"] - cluster["start"])
        hotspots.append(
            {
                "start_time": round(cluster["start"], 3),
                "end_time": round(cluster["end"], 3),
                "duration_seconds": round(duration_seconds, 3),
                "model_count": model_count,
                "models": models,
                "pair_matches": int(cluster["pair_matches"]),
            }
        )

    hotspots.sort(
        key=lambda row: (row["model_count"], row["duration_seconds"], row["pair_matches"]),
        reverse=True,
    )
    return hotspots


def _text_for_time_span(
    timeline_segments: list[tuple[float, float, str]],
    start_time: float,
    end_time: float,
    *,
    max_chars: int = 180,
) -> str:
    """Return a compact text snippet overlapping a hotspot span."""
    chunks: list[str] = []
    for seg_start, seg_end, text in timeline_segments:
        if seg_end <= start_time or seg_start >= end_time:
            continue
        text = text.strip()
        if text:
            chunks.append(text)

    if not chunks:
        return ""

    merged = " ".join(chunks)
    compact = " ".join(merged.split())
    if len(compact) > max_chars:
        return compact[: max_chars - 1].rstrip() + "…"
    return compact


def _detect_cross_model_repetition_hotspots(
    spans_by_audio_hash: dict[str, list[dict[str, Any]]],
    *,
    tolerance_seconds: float = 0.75,
    min_models: int = 2,
) -> dict[str, Any]:
    """Detect repetition hotspots shared across models for the same audio hash."""
    by_audio_hash: list[dict[str, Any]] = []
    compared_hashes = 0
    hashes_with_shared_hotspots = 0
    total_hotspots = 0
    all_models_hotspots = 0

    for audio_hash, rows in sorted(spans_by_audio_hash.items()):
        rows_with_spans = [row for row in rows if row["spans"]]
        if len(rows_with_spans) < 2:
            continue

        compared_hashes += 1
        model_spans = {
            row["model_key"]: sorted((float(start), float(end)) for start, end in row["spans"])
            for row in rows_with_spans
        }
        model_timeline_segments = {
            row["model_key"]: list(row.get("timeline_segments", [])) for row in rows_with_spans
        }
        events = _pairwise_overlap_events(
            model_spans,
            tolerance_seconds=tolerance_seconds,
        )
        hotspots = _merge_overlap_events(
            events,
            tolerance_seconds=tolerance_seconds,
            min_models=min_models,
        )

        models_with_repetition = sorted(model_spans)
        for hotspot in hotspots:
            if hotspot["model_count"] == len(models_with_repetition):
                all_models_hotspots += 1

        if hotspots:
            hashes_with_shared_hotspots += 1
            total_hotspots += len(hotspots)
        top_hotspot_texts: dict[str, str] = {}
        if hotspots:
            top_hotspot = hotspots[0]
            for model_key in top_hotspot["models"]:
                snippet = _text_for_time_span(
                    model_timeline_segments.get(model_key, []),
                    float(top_hotspot["start_time"]),
                    float(top_hotspot["end_time"]),
                )
                if snippet:
                    top_hotspot_texts[model_key] = snippet

        by_audio_hash.append(
            {
                "audio_hash": audio_hash,
                "models_with_repetition": len(models_with_repetition),
                "models": models_with_repetition,
                "hotspot_count": len(hotspots),
                "hotspots": hotspots,
                "top_hotspot_texts": top_hotspot_texts,
            }
        )

    by_audio_hash.sort(
        key=lambda row: (
            row["hotspot_count"],
            row["hotspots"][0]["model_count"] if row["hotspots"] else 0,
            row["hotspots"][0]["duration_seconds"] if row["hotspots"] else 0.0,
        ),
        reverse=True,
    )

    return {
        "summary": {
            "audio_hashes_compared": compared_hashes,
            "audio_hashes_with_shared_hotspots": hashes_with_shared_hotspots,
            "total_hotspots": total_hotspots,
            "all_models_hotspots": all_models_hotspots,
            "tolerance_seconds": tolerance_seconds,
            "min_models": min_models,
        },
        "by_audio_hash": by_audio_hash,
    }


def cmd_repetition(
    *,
    transcripts_root=None,
    backend_filter: list[str] | None = None,
    hash_filter: list[str] | None = None,
    limit: int | None = None,
    min_repeats: int = 2,
    include_char_repeats: bool = False,
    output_format: str = "text",
    return_data: bool = False,
) -> int | dict[str, Any]:
    """Measure repetition severity by transcript/model."""

    use_progress = output_format == "text" and not return_data
    root, records, load_errors = load_transcript_records(
        transcripts_root=transcripts_root,
        backend_filter=backend_filter,
        hash_filter=hash_filter,
        limit=limit,
        show_progress=use_progress,
        progress_description="Loading transcript JSON",
    )

    reports: list[dict[str, Any]] = []
    severity_counts: Counter[str] = Counter()
    flagged_count = 0
    spans_by_audio_hash: dict[str, list[dict[str, Any]]] = {}
    model_segment_totals: dict[str, dict[str, int]] = {}

    def _analyze_record(record: TranscriptRecord) -> None:
        nonlocal flagged_count
        raw_segments = record.data.get("segments", [])
        if raw_segments is not None and not isinstance(raw_segments, list):
            load_errors.append(
                {
                    "path": str(record.path),
                    "error": "invalid_segments_container",
                }
            )
            return

        data_for_detection = record.data
        filtered_segments: list[dict[str, Any]] = []
        if isinstance(raw_segments, list):
            filtered_segments = [row for row in raw_segments if isinstance(row, dict)]
            if len(filtered_segments) != len(raw_segments):
                load_errors.append(
                    {
                        "path": str(record.path),
                        "error": "invalid_segment_row",
                    }
                )
                data_for_detection = dict(record.data)
                data_for_detection["segments"] = filtered_segments

        findings = detect_all_repetitions(
            data_for_detection,
            char_min=2,
            char_max=16 if include_char_repeats else 1,
            min_repeats=min_repeats,
        )
        char_findings = findings.get("chars", [])
        word_findings = findings.get("words", [])
        segment_findings = findings.get("segments", [])
        dedup_char_findings = _select_distinct_findings(char_findings, span_extractor=_char_span)
        dedup_word_findings = _select_distinct_findings(word_findings, span_extractor=_char_span)
        dedup_segment_findings = _select_distinct_findings(
            segment_findings,
            span_extractor=_segment_span,
        )

        counts = {
            "chars": len(dedup_char_findings),
            "words": len(dedup_word_findings),
            "segments": len(dedup_segment_findings),
        }

        score = (
            sum(_finding_impact(f) for f in dedup_char_findings)
            + 2 * sum(_finding_impact(f) for f in dedup_word_findings)
            + 3 * sum(_finding_impact(f) for f in dedup_segment_findings)
        )

        spans: list[tuple[float, float]] = []
        for finding in dedup_segment_findings:
            start_time = coerce_float(finding.start_time)
            end_time = coerce_float(finding.end_time)
            if start_time is None or end_time is None or end_time <= start_time:
                continue
            spans.append((start_time, end_time))

        char_spans: set[tuple[int, int]] = set()
        for finding in dedup_char_findings:
            span = _char_span(finding)
            if span is not None:
                char_spans.add((int(span[0]), int(span[1])))
        for finding in dedup_word_findings:
            span = _char_span(finding)
            if span is not None:
                char_spans.add((int(span[0]), int(span[1])))
        if char_spans:
            spans.extend(_char_spans_to_time_spans(sorted(char_spans), filtered_segments))

        merged = _merge_spans(spans)
        repeated_seconds = sum(end - start for start, end in merged)
        timeline_segments: list[tuple[float, float, str]] = []
        for seg in filtered_segments:
            seg_start = coerce_float(seg.get("start"))
            seg_end = coerce_float(seg.get("end"))
            text = str(seg.get("text", "")).strip()
            if seg_start is None or seg_end is None or seg_end <= seg_start or not text:
                continue
            timeline_segments.append((seg_start, seg_end, text))

        spans_by_audio_hash.setdefault(record.audio_hash, []).append(
            {
                "model_key": record.model_key,
                "spans": merged,
                "timeline_segments": timeline_segments,
            }
        )

        total_segments = len(filtered_segments)
        repeated_segment_indices: set[int] = set()
        if total_segments > 0:
            for finding in dedup_segment_findings:
                if finding.segment_start is None or finding.segment_end is None:
                    continue
                start_idx = max(0, int(finding.segment_start))
                end_idx = min(total_segments - 1, int(finding.segment_end))
                if end_idx < start_idx:
                    continue
                repeated_segment_indices.update(range(start_idx, end_idx + 1))

        repeated_segments_count = len(repeated_segment_indices)
        model_stats = model_segment_totals.setdefault(
            record.model_key,
            {"files": 0, "total_segments": 0, "repeated_segments": 0},
        )
        model_stats["files"] += 1
        model_stats["total_segments"] += total_segments
        model_stats["repeated_segments"] += repeated_segments_count

        duration = transcript_duration(record)
        repeated_coverage = (repeated_seconds / duration) if duration else None
        level = _severity(score, repeated_coverage)

        reports.append(
            {
                "audio_hash": record.audio_hash,
                "backend": record.backend,
                "model": record.model,
                "model_key": record.model_key,
                "path": str(record.path),
                "duration_seconds": duration,
                "counts": counts,
                "severity_score": round(score, 3),
                "severity": level,
                "repeated_seconds": round(repeated_seconds, 3),
                "repeated_coverage": round(repeated_coverage, 4)
                if repeated_coverage is not None
                else None,
                "segment_repetition": {
                    "total_segments": total_segments,
                    "repeated_segments": repeated_segments_count,
                    "repeated_segment_ratio": round(repeated_segments_count / total_segments, 4)
                    if total_segments > 0
                    else None,
                },
                "top_findings": {
                    "chars": [_finding_payload(f) for f in dedup_char_findings[:5]],
                    "words": [_finding_payload(f) for f in dedup_word_findings[:5]],
                    "segments": [_finding_payload(f) for f in dedup_segment_findings[:5]],
                },
            }
        )

        severity_counts[level] += 1
        if level != "none":
            flagged_count += 1

    if use_progress and records:
        console = Console()
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            TimeElapsedColumn(),
            console=console,
            transient=False,
        ) as progress:
            task = progress.add_task("Analyzing repetition...", total=len(records))
            for idx, record in enumerate(records, start=1):
                _analyze_record(record)
                progress.advance(task)
                if idx % 100 == 0 or idx == len(records):
                    progress.update(
                        task,
                        description=f"Analyzing repetition (flagged={flagged_count})",
                    )
    else:
        for record in records:
            _analyze_record(record)

    reports.sort(key=lambda row: row["severity_score"], reverse=True)
    cross_model = _detect_cross_model_repetition_hotspots(spans_by_audio_hash)
    model_segment_repetition: list[dict[str, Any]] = []
    for model_key, stats in model_segment_totals.items():
        total_segments = stats["total_segments"]
        repeated_segments = stats["repeated_segments"]
        repeated_segment_ratio = (repeated_segments / total_segments) if total_segments > 0 else 0.0
        model_segment_repetition.append(
            {
                "model_key": model_key,
                "files": stats["files"],
                "total_segments": total_segments,
                "repeated_segments": repeated_segments,
                "repeated_segment_ratio": round(repeated_segment_ratio, 4),
            }
        )
    model_segment_repetition.sort(
        key=lambda row: (row["repeated_segment_ratio"], row["repeated_segments"]),
        reverse=True,
    )

    payload: dict[str, Any] = {
        "transcripts_root": str(root),
        "summary": {
            "total_files": len(records),
            "flagged_files": flagged_count,
            "severity_counts": dict(severity_counts),
            "load_errors": len(load_errors),
            "min_repeats": min_repeats,
            "include_char_repeats": include_char_repeats,
            "shared_repeat_audio_hashes": cross_model["summary"][
                "audio_hashes_with_shared_hotspots"
            ],
            "shared_repeat_hotspots": cross_model["summary"]["total_hotspots"],
        },
        "reports": reports,
        "load_errors": load_errors,
        "cross_model": cross_model,
        "model_segment_repetition": model_segment_repetition,
    }

    if return_data:
        return payload

    if output_format == "json":
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    summary = payload["summary"]
    print("Repetition analysis")
    print(f"Root: {payload['transcripts_root']}")
    print(
        f"Files: {summary['total_files']} "
        f"(flagged={summary['flagged_files']}, min_repeats={summary['min_repeats']})"
    )

    if summary["load_errors"]:
        print(f"Load errors: {summary['load_errors']}")

    for row in reports[:20]:
        if row["severity"] == "none":
            continue
        coverage = row["repeated_coverage"]
        coverage_text = f"{coverage:.1%}" if coverage is not None else "n/a"
        print(
            f"  {row['severity'].upper():6} {row['model_key']} {row['audio_hash'][:12]} "
            f"score={row['severity_score']:.1f} coverage={coverage_text}"
        )

    cross_summary = cross_model["summary"]
    print(
        "Shared hotspots: "
        f"{cross_summary['audio_hashes_with_shared_hotspots']} hashes, "
        f"{cross_summary['total_hotspots']} hotspot(s) "
        f"(all-model={cross_summary['all_models_hotspots']})"
    )
    for entry in cross_model["by_audio_hash"][:25]:
        if not entry["hotspots"]:
            continue
        top = entry["hotspots"][0]
        print(
            f"  {entry['audio_hash'][:12]} "
            f"models={top['model_count']}/{entry['models_with_repetition']} "
            f"span={top['start_time']:.2f}-{top['end_time']:.2f}s "
            f"dur={top['duration_seconds']:.2f}s"
        )
        for model_key in top["models"]:
            snippet = entry.get("top_hotspot_texts", {}).get(model_key)
            if not snippet:
                continue
            print(f"    {model_key}: {snippet}")

    print("Per-model repeated segments:")
    for row in model_segment_repetition:
        percent = row["repeated_segment_ratio"] * 100.0
        print(
            f"  {row['model_key']} "
            f"{row['repeated_segments']}/{row['total_segments']} "
            f"({percent:.1f}%) files={row['files']}"
        )

    return 0


__all__ = ["cmd_repetition"]
