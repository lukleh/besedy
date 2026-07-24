from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np


def load_question_records(path: Path | str) -> list[dict[str, Any]]:
    records = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(records, list):
        raise ValueError("Questions file must contain a JSON array.")

    normalized: list[dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        question = str(record.get("question", "")).strip()
        if not question:
            continue
        normalized.append(record)
    if not normalized:
        raise ValueError("Questions file does not contain any usable questions.")
    return normalized


def duration_stats(durations_ms: list[float]) -> dict[str, float]:
    values = np.asarray(durations_ms, dtype=np.float64)
    return {
        "min_ms": float(np.min(values)),
        "mean_ms": float(np.mean(values)),
        "median_ms": float(np.median(values)),
        "p95_ms": float(np.percentile(values, 95)),
        "p99_ms": float(np.percentile(values, 99)),
        "max_ms": float(np.max(values)),
    }


__all__ = ["duration_stats", "load_question_records"]
