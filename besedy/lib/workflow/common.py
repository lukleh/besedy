"""Shared utilities for Besedy transcription workflow runners."""

from __future__ import annotations

import csv
import re
import unicodedata
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

# Exit code of a step that ran but skipped some rows (a missing source, an
# undecodable file, an unreadable transcript). 1 means the step itself failed.
# run-pipeline continues past it, so one bad row cannot block every other row.
EXIT_ROWS_SKIPPED = 2


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
        scan_root: The catalog's ``Scan Root`` for this file, if the CSV has one.
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
    scan_root: str | None = None


def parse_duration_to_seconds(value: str) -> float:
    """Parse the catalog's canonical ``HH:MM:SS`` duration."""
    text = value.strip()
    if not text:
        raise ValueError("empty duration")
    if not re.fullmatch(r"[0-9]{2,}:[0-5][0-9]:[0-5][0-9]", text):
        raise ValueError("duration must be HH:MM:SS")
    hours, minutes, seconds = text.split(":")
    hours_i, minutes_i, seconds_f = int(hours), int(minutes), int(seconds)
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

    Requires current case-sensitive column names and extracts optional
    normalization parameters if present in the CSV.

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

        required = ["Hash", "Full Path"]
        if require_duration:
            required.append("Duration")
        missing = [column for column in required if column not in reader.fieldnames]
        if missing:
            raise ValueError(f"CSV must include {missing} column(s) in {csv_path}")

        for index, row in enumerate(reader, start=2):
            sha = (row.get("Hash") or "").strip()
            full_path = (row.get("Full Path") or "").strip()
            if not sha or not full_path:
                continue

            duration_value: float | None = None
            if require_duration:
                duration_text = (row.get("Duration") or "").strip()
                try:
                    duration_value = parse_duration_to_seconds(duration_text)
                except ValueError as exc:
                    raise ValueError(
                        f"Invalid Duration value '{duration_text}' at row {index} in {csv_path}: {exc}"
                    ) from exc

            norm_params = {
                name: (row.get(name) or "").strip() or None
                for name in (
                    "integrated_loudness_lufs",
                    "true_peak_db",
                    "loudness_range_lu",
                    "input_thresh",
                    "target_offset",
                )
            }

            yield CsvAudioRow(
                sha256=sha,
                full_path=full_path,
                duration_seconds=duration_value,
                added_at=(row.get("added_at") or "").strip() or None,
                scan_root=(row.get("Scan Root") or "").strip() or None,
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
