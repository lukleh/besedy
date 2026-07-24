"""Basic transcript validation checks (JSON-first)."""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from typing import Any

from .common import coerce_float, load_transcript_records, transcript_duration


def _severity_from_issues(issues: dict[str, int]) -> str:
    fail_keys = {
        "empty_transcript",
        "invalid_timestamp",
        "negative_segment_duration",
        "non_monotonic_start",
    }
    if any(issues.get(key, 0) > 0 for key in fail_keys):
        return "fail"

    if any(value > 0 for value in issues.values()):
        return "warning"

    return "ok"


def _quality_score(issues: dict[str, int]) -> int:
    weights = {
        "empty_transcript": 40,
        "invalid_timestamp": 20,
        "negative_segment_duration": 20,
        "non_monotonic_start": 15,
        "overlap": 8,
        "beyond_duration": 8,
        "duration_mismatch": 8,
        "empty_text": 3,
        "missing_duration": 2,
        "high_char_rate": 2,
        "high_word_rate": 2,
        "negative_start": 2,
    }
    penalty = 0
    for key, count in issues.items():
        penalty += weights.get(key, 1) * count
    return max(0, 100 - penalty)


def cmd_validate(
    *,
    transcripts_root=None,
    backend_filter: list[str] | None = None,
    hash_filter: list[str] | None = None,
    limit: int | None = None,
    output_format: str = "text",
    return_data: bool = False,
) -> int | dict[str, Any]:
    """Validate transcript timing/content consistency from JSON files."""

    root, records, load_errors = load_transcript_records(
        transcripts_root=transcripts_root,
        backend_filter=backend_filter,
        hash_filter=hash_filter,
        limit=limit,
    )

    file_reports: list[dict[str, Any]] = []
    severity_counts: Counter[str] = Counter()
    issue_totals: Counter[str] = Counter()
    by_model: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "total": 0,
            "ok": 0,
            "warning": 0,
            "fail": 0,
            "issues": Counter(),
        }
    )

    for record in records:
        raw_segments = record.data.get("segments") if isinstance(record.data, dict) else None
        if not isinstance(raw_segments, list):
            raw_segments = []

        issues: dict[str, int] = {
            "empty_transcript": 0,
            "invalid_timestamp": 0,
            "negative_segment_duration": 0,
            "non_monotonic_start": 0,
            "overlap": 0,
            "beyond_duration": 0,
            "duration_mismatch": 0,
            "empty_text": 0,
            "missing_duration": 0,
            "high_char_rate": 0,
            "high_word_rate": 0,
            "negative_start": 0,
        }

        if not raw_segments:
            issues["empty_transcript"] += 1

        duration = transcript_duration(record)
        if duration is None:
            issues["missing_duration"] += 1

        prev_start: float | None = None
        prev_end: float | None = None
        max_end: float = 0.0
        valid_segments = 0

        for seg in raw_segments:
            if not isinstance(seg, dict):
                issues["invalid_timestamp"] += 1
                continue

            start = coerce_float(seg.get("start"))
            end = coerce_float(seg.get("end"))
            text = str(seg.get("text", "")).strip()

            if start is None or end is None:
                issues["invalid_timestamp"] += 1
                continue
            if end < start:
                issues["negative_segment_duration"] += 1
                continue

            valid_segments += 1
            max_end = max(max_end, end)

            if start < -0.05:
                issues["negative_start"] += 1

            if prev_start is not None and start + 1e-6 < prev_start:
                issues["non_monotonic_start"] += 1
            if prev_end is not None and start + 1e-3 < prev_end:
                issues["overlap"] += 1

            prev_start = start
            prev_end = end if prev_end is None else max(prev_end, end)

            if not text:
                issues["empty_text"] += 1

            span = end - start
            if span > 0 and text:
                chars_per_sec = len(text) / span
                words_per_sec = len(text.split()) / span
                if chars_per_sec > 35:
                    issues["high_char_rate"] += 1
                if words_per_sec > 6:
                    issues["high_word_rate"] += 1

            if duration is not None and end > duration + 0.5:
                issues["beyond_duration"] += 1

        if duration is not None and valid_segments > 0:
            mismatch_tolerance = max(3.0, duration * 0.15)
            if abs(max_end - duration) > mismatch_tolerance:
                issues["duration_mismatch"] += 1

        severity = _severity_from_issues(issues)
        score = _quality_score(issues)

        file_report = {
            "audio_hash": record.audio_hash,
            "backend": record.backend,
            "model": record.model,
            "model_key": record.model_key,
            "path": str(record.path),
            "duration_seconds": duration,
            "segment_count": len(raw_segments),
            "valid_segment_count": valid_segments,
            "quality_score": score,
            "severity": severity,
            "issues": issues,
        }

        file_reports.append(file_report)
        severity_counts[severity] += 1

        model_bucket = by_model[record.model_key]
        model_bucket["total"] += 1
        model_bucket[severity] += 1
        model_bucket["issues"].update({k: v for k, v in issues.items() if v > 0})

        issue_totals.update({k: v for k, v in issues.items() if v > 0})

    file_reports.sort(key=lambda row: (row["severity"] != "fail", row["quality_score"]))

    by_model_payload = {}
    for model_key, bucket in sorted(by_model.items()):
        by_model_payload[model_key] = {
            "total": bucket["total"],
            "ok": bucket["ok"],
            "warning": bucket["warning"],
            "fail": bucket["fail"],
            "issues": dict(bucket["issues"]),
        }

    payload: dict[str, Any] = {
        "transcripts_root": str(root),
        "summary": {
            "total_files": len(records),
            "ok": severity_counts["ok"],
            "warning": severity_counts["warning"],
            "fail": severity_counts["fail"],
            "load_errors": len(load_errors),
        },
        "issue_totals": dict(issue_totals),
        "by_model": by_model_payload,
        "files": file_reports,
        "load_errors": load_errors,
    }

    if return_data:
        return payload

    if output_format == "json":
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    summary = payload["summary"]
    print("Transcript validation")
    print(f"Root: {payload['transcripts_root']}")
    print(
        f"Files: {summary['total_files']} (ok={summary['ok']}, warning={summary['warning']}, fail={summary['fail']})"
    )

    if summary["load_errors"]:
        print(f"Load errors: {summary['load_errors']}")

    if issue_totals:
        print("\nTop issues:")
        for name, count in issue_totals.most_common(10):
            print(f"  {name}: {count}")

    bad_files = [row for row in file_reports if row["severity"] != "ok"]
    if bad_files:
        print("\nWorst files:")
        for row in bad_files[:20]:
            print(
                f"  {row['severity'].upper():7} {row['model_key']} {row['audio_hash'][:12]} score={row['quality_score']}"
            )

    return 0


__all__ = ["cmd_validate"]
