"""Shared utilities for Besedy transcription workflow runners."""

from __future__ import annotations

import csv
import unicodedata
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class WorkflowCommand:
    """Represents a command that launches a transcription workflow."""

    label: str
    argv: Sequence[str]
    extra_env: dict[str, str] | None = None
    parallel_group: str | None = None


@dataclass(frozen=True)
class CsvAudioRow:
    """Normalized representation of a CSV row from the audio catalog.

    Attributes:
        sha256: Audio content hash (SHA-256 of decoded PCM at 16kHz mono).
                Field name kept for backward compatibility.
        full_path: Full path to the audio file.
    """

    sha256: str  # Actually audio content hash (kept for backward compat)
    full_path: str
    duration_seconds: float | None = None
    added_at: str | None = None  # ISO 8601 timestamp when record was added
    # Normalization parameters (optional, for pre-analyzed audio)
    integrated_loudness_lufs: str | None = None
    true_peak_db: str | None = None
    loudness_range_lu: str | None = None
    input_thresh: str | None = None
    target_offset: str | None = None


def _normalize_fieldnames(fieldnames: Sequence[str]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for name in fieldnames:
        key = name.strip().lower()
        if key not in normalized:
            normalized[key] = name
    return normalized


def _require_columns(
    normalized_fields: dict[str, str],
    required: Sequence[str],
    *,
    csv_path: Path,
) -> dict[str, str]:
    missing = [column for column in required if column not in normalized_fields]
    if missing:
        display_required = ", ".join(f"'{column}'" for column in required)
        raise ValueError(
            f"CSV must include {display_required} column(s) (found: {list(normalized_fields.values())}) "
            f"in {csv_path}"
        )
    return {column: normalized_fields[column] for column in required}


def parse_duration_to_seconds(value: str) -> float:
    """Parse ``MM:SS`` or ``HH:MM:SS`` durations into seconds."""
    text = value.strip()
    if not text:
        raise ValueError("empty duration")
    parts = text.split(":")
    if len(parts) == 2:
        hours = 0
        minutes, seconds = parts
    elif len(parts) == 3:
        hours, minutes, seconds = parts
    else:
        raise ValueError("duration must be MM:SS or HH:MM:SS")
    try:
        hours_i = int(hours)
        minutes_i = int(minutes)
        seconds_f = float(seconds)
    except ValueError as exc:
        raise ValueError("duration contains non-numeric component") from exc
    if hours_i < 0 or minutes_i < 0 or seconds_f < 0:
        raise ValueError("duration cannot be negative")
    if seconds_f >= 60:
        raise ValueError("duration seconds component out of range")
    if hours_i > 0 and minutes_i >= 60:
        raise ValueError("duration minutes component out of range")
    total_seconds = hours_i * 3600 + minutes_i * 60 + seconds_f
    if total_seconds <= 0:
        raise ValueError("duration must be positive")
    return float(total_seconds)


def iter_audio_csv_rows(
    csv_path: Path,
    *,
    require_duration: bool = False,
) -> Iterator[CsvAudioRow]:
    """Iterate over audio catalog CSV rows, yielding normalized CsvAudioRow objects.

    Handles column name normalization (case-insensitive, whitespace-stripped) and
    extracts optional normalization parameters if present in the CSV.

    Args:
        csv_path: Path to the audio catalog CSV file.
        require_duration: If True, Duration column is required and parsed.

    Yields:
        CsvAudioRow with sha256, full_path, duration_seconds (if required),
        and optional loudness normalization parameters.

    Raises:
        ValueError: If required columns are missing or duration parsing fails.
    """
    with csv_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError(f"No header row found in {csv_path}")

        normalized = _normalize_fieldnames(reader.fieldnames)

        if "hash" not in normalized:
            raise ValueError(
                f"CSV must include 'Hash' column (found: {list(normalized.values())}) in {csv_path}"
            )
        hash_column = "hash"

        required_columns = _require_columns(
            normalized,
            (hash_column, "full path"),
            csv_path=csv_path,
        )
        duration_column = None
        if require_duration:
            duration_mapping = _require_columns(normalized, ("duration",), csv_path=csv_path)
            duration_column = duration_mapping["duration"]

        sha_key = required_columns[hash_column]
        path_key = required_columns["full path"]

        # Optional columns
        added_at_col = normalized.get("added_at")
        norm_cols = {
            "integrated_loudness_lufs": normalized.get("integrated_loudness_lufs"),
            "true_peak_db": normalized.get("true_peak_db"),
            "loudness_range_lu": normalized.get("loudness_range_lu"),
            "input_thresh": normalized.get("input_thresh"),
            "target_offset": normalized.get("target_offset"),
        }

        for index, row in enumerate(reader, start=2):
            sha = (row.get(sha_key) or "").strip()
            full_path = (row.get(path_key) or "").strip()
            if not sha or not full_path:
                continue

            duration_value: float | None = None
            if duration_column is not None:
                duration_text = (row.get(duration_column) or "").strip()
                try:
                    duration_value = parse_duration_to_seconds(duration_text)
                except ValueError as exc:
                    raise ValueError(
                        f"Invalid Duration value '{duration_text}' at row {index} in {csv_path}: {exc}"
                    ) from exc

            # Extract added_at timestamp if available
            added_at_value: str | None = None
            if added_at_col is not None:
                added_at_value = (row.get(added_at_col) or "").strip() or None

            # Extract normalization parameters if available
            norm_params = {}
            for param_name, col_name in norm_cols.items():
                if col_name is not None:
                    value = (row.get(col_name) or "").strip()
                    norm_params[param_name] = value if value else None
                else:
                    norm_params[param_name] = None

            yield CsvAudioRow(
                sha256=sha,
                full_path=full_path,
                duration_seconds=duration_value,
                added_at=added_at_value,
                **norm_params,
            )


def resolve_unicode_path(path_str: str) -> tuple[Path, str, bool]:
    """Resolve a filesystem path while normalizing Unicode variants."""
    candidates = []

    def add(value: str) -> None:
        if value not in candidates:
            candidates.append(value)

    add(path_str)
    add(unicodedata.normalize("NFC", path_str))
    add(unicodedata.normalize("NFD", path_str))

    for candidate in candidates:
        path_obj = Path(candidate).expanduser()
        if path_obj.exists():
            return path_obj, candidate, True

    fallback = candidates[0] if candidates else path_str
    return Path(fallback).expanduser(), fallback, False
