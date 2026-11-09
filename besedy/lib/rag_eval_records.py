"""Shared parsing and matching for retrieval-evaluation records."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from besedy.core.paths import SHA256_HASH_PATTERN

_TIME_KEYS = {"start_seconds", "end_seconds"}


@dataclass(frozen=True)
class EvalTarget:
    """Validated retrieval target from an evaluation fixture."""

    chunk_id: str | None
    audio_hash: str | None
    start_sec: float | None
    end_sec: float | None

    def matches_audio(self, audio_hash: str) -> bool:
        return self.audio_hash is not None and audio_hash.lower() == self.audio_hash

    def matches(
        self,
        *,
        chunk_id: str,
        audio_hash: str,
        start_sec: float,
        end_sec: float,
    ) -> bool:
        if self.chunk_id is not None and chunk_id == self.chunk_id:
            return True
        if not self.matches_audio(audio_hash):
            return False
        if self.start_sec is None or self.end_sec is None:
            return True
        overlap = min(end_sec, self.end_sec) - max(start_sec, self.start_sec)
        return overlap > 0


def load_eval_records(path: Path | str) -> list[dict[str, Any]]:
    raw_records = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw_records, list):
        raise ValueError("Questions file must contain a JSON array.")
    if not raw_records:
        raise ValueError("Questions file must contain at least one evaluation record.")

    records: list[dict[str, Any]] = []
    for index, raw_record in enumerate(raw_records):
        if not isinstance(raw_record, dict):
            raise ValueError(f"Evaluation record {index} must be a JSON object.")
        record = cast(dict[str, Any], raw_record)
        record_label = _record_label(record, fallback=str(index))
        if not record_query(record):
            raise ValueError(f"{record_label} must define a non-empty 'question' field.")
        if not parse_eval_targets(record):
            raise ValueError(f"{record_label} must define at least one target.")
        records.append(record)
    return records


def record_query(record: dict[str, Any]) -> str:
    """Return the question from the current evaluation record format."""

    if "query" in record:
        raise ValueError("Evaluation records use 'question'; migrate the retired 'query' field")
    value = record.get("question")
    return value.strip() if isinstance(value, str) else ""


def parse_eval_targets(record: dict[str, Any]) -> list[EvalTarget]:
    raw_targets = record.get("targets")
    if not isinstance(raw_targets, list) or not raw_targets:
        return []

    record_label = _record_label(record)
    targets: list[EvalTarget] = []
    for index, raw_target in enumerate(raw_targets):
        target_label = f"{record_label} target {index}"
        if not isinstance(raw_target, dict):
            raise ValueError(f"{target_label} must be a JSON object.")
        targets.append(_parse_eval_target(cast(dict[str, Any], raw_target), label=target_label))
    return targets


def _parse_eval_target(target: dict[str, Any], *, label: str) -> EvalTarget:
    chunk_id = _optional_nonempty_string(target, "chunk_id", label=label)
    audio_hash = _optional_nonempty_string(target, "audio_hash", label=label)
    if audio_hash is not None:
        audio_hash = audio_hash.lower()
        if SHA256_HASH_PATTERN.fullmatch(audio_hash) is None:
            raise ValueError(
                f"{label} field 'audio_hash' must be a 64-character SHA-256 hex string."
            )

    start_sec, end_sec = _parse_time_span(target, label=label)
    if chunk_id is None and audio_hash is None:
        raise ValueError(f"{label} must define chunk_id or audio_hash.")
    if start_sec is not None and audio_hash is None:
        raise ValueError(f"{label} time fields require audio_hash.")

    return EvalTarget(
        chunk_id=chunk_id,
        audio_hash=audio_hash,
        start_sec=start_sec,
        end_sec=end_sec,
    )


def _optional_nonempty_string(
    payload: dict[str, Any],
    key: str,
    *,
    label: str,
) -> str | None:
    if key not in payload:
        return None
    value = payload[key]
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} field {key!r} must be a non-empty string.")
    return value.strip()


def _parse_time_span(
    target: dict[str, Any],
    *,
    label: str,
) -> tuple[float | None, float | None]:
    unsupported_time_keys = sorted(
        key
        for key in target
        if isinstance(key, str) and key.startswith(("start", "end")) and key not in _TIME_KEYS
    )
    if unsupported_time_keys:
        raise ValueError(
            f"{label} uses unsupported time field(s): {', '.join(unsupported_time_keys)}."
        )

    has_start = "start_seconds" in target
    has_end = "end_seconds" in target
    if not has_start and not has_end:
        return None, None
    if not has_start or not has_end:
        raise ValueError(f"{label} must define both start and end time fields.")

    start_sec = _parse_time(target["start_seconds"], key="start_seconds", label=label)
    end_sec = _parse_time(target["end_seconds"], key="end_seconds", label=label)
    if start_sec < 0:
        raise ValueError(f"{label} start time must be non-negative.")
    if start_sec >= end_sec:
        raise ValueError(f"{label} time span must satisfy start < end.")
    return start_sec, end_sec


def _record_label(record: dict[str, Any], *, fallback: str = "<unknown>") -> str:
    record_id = record.get("id")
    if isinstance(record_id, str) and record_id.strip():
        return f"Evaluation record {record_id.strip()!r}"
    return f"Evaluation record {fallback}"


def _parse_time(value: Any, *, key: str, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label} field {key!r} must be a finite number.")
    return float(value)


__all__ = [
    "EvalTarget",
    "load_eval_records",
    "parse_eval_targets",
    "record_query",
]
