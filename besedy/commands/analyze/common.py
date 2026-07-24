"""Shared JSON-first helpers for analyze commands."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

from besedy.core.paths import (
    iter_transcript_paths,
    parse_transcript_components,
    resolve_transcripts_root,
)
from besedy.lib.analysis.comparison import ModelSegment
from besedy.lib.data.encoding import load_json_with_fallback


@dataclass(slots=True)
class TranscriptRecord:
    """Loaded transcript JSON and resolved metadata."""

    backend: str
    model: str
    audio_hash: str
    model_key: str
    path: Path
    data: dict[str, Any]


def coerce_float(value: Any) -> float | None:
    """Return float(value) when possible, else None."""

    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def load_transcript_records(
    *,
    transcripts_root: Path | None = None,
    backend_filter: list[str] | None = None,
    hash_filter: list[str] | None = None,
    limit: int | None = None,
    show_progress: bool = False,
    progress_description: str = "Loading transcripts",
) -> tuple[Path, list[TranscriptRecord], list[dict[str, str]]]:
    """Load transcript JSON files with optional backend/hash filtering."""

    root = resolve_transcripts_root(transcripts_root)
    backend_allowed = set(backend_filter or [])

    records: list[TranscriptRecord] = []
    errors: list[dict[str, str]] = []

    def _ingest(path: Path) -> None:
        nonlocal records, errors
        components = parse_transcript_components(path, root)
        if not components:
            return

        backend, model, audio_hash = components

        if backend_allowed and backend not in backend_allowed:
            return
        if hash_filter and not any(audio_hash.startswith(prefix) for prefix in hash_filter):
            return

        try:
            data = load_json_with_fallback(path)
        except Exception as exc:  # pragma: no cover - defensive
            errors.append({"path": str(path), "error": str(exc)})
            return

        if not isinstance(data, dict):
            errors.append({"path": str(path), "error": "invalid_json_root"})
            return

        records.append(
            TranscriptRecord(
                backend=backend,
                model=model,
                audio_hash=audio_hash,
                model_key=f"{backend}/{model}",
                path=path,
                data=data,
            )
        )

    if show_progress:
        console = Console()

        transcript_paths: list[Path] = []
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            TimeElapsedColumn(),
            console=console,
            transient=False,
        ) as progress:
            scan_task = progress.add_task("Discovering transcript files...", total=None)
            for idx, path in enumerate(iter_transcript_paths(root), start=1):
                transcript_paths.append(path)
                if idx % 200 == 0:
                    progress.update(
                        scan_task,
                        description=f"Discovering transcript files (found={idx})",
                    )
            progress.update(
                scan_task,
                description=f"Discovering transcript files (found={len(transcript_paths)})",
            )

        total_paths = len(transcript_paths)
        description = f"{progress_description}..."

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            TimeElapsedColumn(),
            console=console,
            transient=False,
        ) as progress:
            task = progress.add_task(description, total=total_paths)
            scanned = 0

            for path in transcript_paths:
                _ingest(path)
                scanned += 1
                progress.advance(task)

                if scanned % 100 == 0 or scanned == total_paths:
                    progress.update(
                        task,
                        description=(
                            f"{progress_description} (loaded={len(records)}, errors={len(errors)})"
                        ),
                    )

                if limit and len(records) >= limit:
                    progress.update(
                        task,
                        total=scanned,
                        completed=scanned,
                        description=(
                            f"{progress_description} "
                            f"(loaded={len(records)}, errors={len(errors)}, limit reached)"
                        ),
                    )
                    break
    else:
        for path in iter_transcript_paths(root):
            _ingest(path)
            if limit and len(records) >= limit:
                break

    return root, records, errors


def group_by_audio_hash(records: list[TranscriptRecord]) -> dict[str, list[TranscriptRecord]]:
    """Group transcript records by audio hash."""

    grouped: dict[str, list[TranscriptRecord]] = {}
    for record in records:
        grouped.setdefault(record.audio_hash, []).append(record)
    return grouped


def extract_segments(record: TranscriptRecord) -> list[ModelSegment]:
    """Convert transcript segments to ModelSegment rows.

    Invalid rows are skipped to keep command logic robust with partial data.
    """

    raw_segments = record.data.get("segments")
    if not isinstance(raw_segments, list):
        return []

    segments: list[ModelSegment] = []
    for row in raw_segments:
        if not isinstance(row, dict):
            continue
        start = coerce_float(row.get("start"))
        end = coerce_float(row.get("end"))
        if start is None or end is None or end <= start:
            continue
        text = str(row.get("text", "")).strip()
        confidence = coerce_float(row.get("confidence"))
        segments.append(
            ModelSegment(
                start=start,
                end=end,
                text=text,
                confidence=confidence,
            )
        )

    segments.sort(key=lambda seg: (seg.start, seg.end))
    return segments


def transcript_duration(record: TranscriptRecord) -> float | None:
    """Return transcript duration from meta.duration when present."""

    meta = record.data.get("meta")
    if not isinstance(meta, dict):
        return None
    duration = coerce_float(meta.get("duration"))
    if duration is None or duration <= 0:
        return None
    return duration


def span_text(segments: list[ModelSegment], start: float, end: float) -> str:
    """Return concatenated text of segments overlapping the target span."""

    chunks: list[str] = []
    for seg in segments:
        if seg.end <= start or seg.start >= end:
            continue
        text = seg.text.strip()
        if text:
            chunks.append(text)
    return " ".join(chunks).strip()


def overlap_ratio(segments: list[ModelSegment], start: float, end: float) -> float:
    """Return fraction of [start, end] covered by overlapping segments."""

    span = max(0.0, end - start)
    if span == 0:
        return 0.0

    covered = 0.0
    for seg in segments:
        overlap_start = max(start, seg.start)
        overlap_end = min(end, seg.end)
        if overlap_end > overlap_start:
            covered += overlap_end - overlap_start

    return min(1.0, covered / span)
