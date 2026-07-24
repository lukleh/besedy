"""Shared transcript validation helpers used by the unified CLI."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

from besedy.lib.data.encoding import load_json_with_fallback


def load_json(path: Path) -> dict[str, Any]:
    """Load JSON file with an encoding fallback for legacy outputs."""
    return load_json_with_fallback(path)


def _summarize_counts(data: dict[str, Any]) -> tuple[int, int]:
    segments = data.get("segments", []) if isinstance(data, dict) else []
    words = sum(len(seg.get("words", [])) for seg in segments if isinstance(seg, dict))
    return len(segments), words


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_shared_schema(data: dict[str, Any]) -> list[str]:
    """Schema checks aligned with Polars loader expectations."""

    issues: list[str] = []

    if not isinstance(data, dict):
        return ["Top-level JSON must be an object"]

    segments = data.get("segments")
    if not isinstance(segments, list) or not segments:
        issues.append("Missing or empty 'segments' list")
        return issues

    for idx, seg in enumerate(segments):
        if not isinstance(seg, dict):
            issues.append(f"Segment {idx} is not an object")
            continue
        seg = cast(dict[str, Any], seg)

        for key in ("start", "end", "text"):
            if key not in seg:
                issues.append(f"Segment {idx} missing '{key}'")

        if "start" in seg and not _is_number(seg.get("start")):
            issues.append(f"Segment {idx} 'start' must be a number")
        if "end" in seg and not _is_number(seg.get("end")):
            issues.append(f"Segment {idx} 'end' must be a number")
        if "text" in seg and not isinstance(seg.get("text"), str):
            issues.append(f"Segment {idx} 'text' must be a string")
        if "confidence" in seg and not _is_number(seg.get("confidence")):
            issues.append(f"Segment {idx} 'confidence' must be a number")

        if "words" in seg:
            words = seg.get("words")
            if not isinstance(words, list):
                issues.append(f"Segment {idx} 'words' must be a list")
                continue
            for w_idx, word in enumerate(words):
                if not isinstance(word, dict):
                    issues.append(f"Segment {idx} word {w_idx} is not an object")
                    continue
                word = cast(dict[str, Any], word)
                for key in ("start", "end", "word"):
                    if key not in word:
                        issues.append(f"Segment {idx} word {w_idx} missing '{key}'")
                if "start" in word and not _is_number(word.get("start")):
                    issues.append(f"Segment {idx} word {w_idx} 'start' must be a number")
                if "end" in word and not _is_number(word.get("end")):
                    issues.append(f"Segment {idx} word {w_idx} 'end' must be a number")
                if "word" in word and not isinstance(word.get("word"), str):
                    issues.append(f"Segment {idx} word {w_idx} 'word' must be a string")
                if "confidence" in word and not _is_number(word.get("confidence")):
                    issues.append(f"Segment {idx} word {w_idx} 'confidence' must be a number")

    if "meta" in data and not isinstance(data.get("meta"), dict):
        issues.append("'meta' must be an object when provided")

    return issues


def validate_single_file(
    path: Path,
    verbose: bool = False,
    max_issues_display: int = 10,
    *,
    quiet: bool = False,
    summary: dict[str, Any] | None = None,
) -> bool:
    """Validate a single transcript file against the shared schema.

    When ``quiet`` is True, suppress per-file logging (useful for batch runs).
    ``summary`` can be provided to collect lightweight stats for reporting.
    """

    def _emit(msg: str) -> None:
        if not quiet:
            print(msg)

    def _record(**kwargs: Any) -> None:
        if summary is not None:
            summary.update(kwargs)

    _record(file=str(path))

    if not path.exists():
        _emit(f"Error: File not found: {path}")
        _record(status="missing", message="file not found")
        return False

    _emit(f"Validating: {path.name}")

    try:
        data = load_json(path)
    except ValueError as exc:
        _emit(f"Error: {exc}")
        _record(status="failed", message=str(exc))
        return False

    schema_issues = validate_shared_schema(data)

    if schema_issues:
        _emit(f"  ✗ Schema validation failed ({len(schema_issues)} issue(s))")
        display_cap = max_issues_display if verbose else min(5, max_issues_display)
        for issue in schema_issues[:display_cap]:
            _emit(f"    - {issue}")
        remaining = len(schema_issues) - display_cap
        if remaining > 0:
            _emit(f"    ... and {remaining} more (use -v for more)")
        _emit("\n" + "=" * 70)
        _emit(f"✗ Validation failed with {len(schema_issues)} issue(s) for {path.name}")
        _record(
            status="failed",
            issues=len(schema_issues),
            message=schema_issues[0] if schema_issues else None,
        )
        return False

    seg_count, word_count = _summarize_counts(data)
    _emit("  ✓ Schema validation passed")
    _emit(f"    Segments: {seg_count}, Words: {word_count}")

    _emit("\n" + "=" * 70)
    _emit(f"✓ All checks passed for {path.name}")
    _record(status="passed", segments=seg_count, words=word_count, issues=0)
    return True


def validate_conversion(
    converted_path: Path,
    original_path: Path,
    backend: str,
) -> bool:
    """Validate conversion from backend-specific JSON to canonical format."""

    print(f"Verifying conversion: {converted_path.name}")
    print(f"  Original: {original_path.name}")
    print(f"  Backend: {backend}")

    load_json(converted_path)
    load_json(original_path)

    print(f"Error: Conversion verification not implemented for backend: {backend}")
    return False


def validate_diarization_file(
    path: Path,
    *,
    quiet: bool = False,
    verbose: bool = False,
    summary: dict[str, Any] | None = None,
    max_issues_display: int = 10,
) -> bool:
    """Validate a single diarization speakers.json file.

    Checks for required fields, numeric start/end, non-empty speaker labels,
    and positive segment durations. Collects lightweight stats into ``summary``
    when provided.
    """

    def _emit(msg: str) -> None:
        if not quiet:
            print(msg)

    def _record(**kwargs: Any) -> None:
        if summary is not None:
            summary.update(kwargs)

    _record(file=str(path))

    if not path.exists():
        _emit(f"Error: File not found: {path}")
        _record(status="missing", message="file not found")
        return False

    try:
        data = load_json(path)
    except ValueError as exc:
        _emit(f"Error: {exc}")
        _record(status="failed", message=str(exc))
        return False

    segments_raw = data.get("segments")
    if not isinstance(segments_raw, list) or not segments_raw:
        _emit("✗ Missing or empty 'segments' list")
        _record(status="failed", message="missing segments")
        return False

    issues: list[str] = []
    speakers: set[str] = set()
    total_duration = 0.0
    prev_start: float | None = None

    for idx, seg in enumerate(segments_raw):
        if not isinstance(seg, dict):
            issues.append(f"Segment {idx} is not an object")
            continue
        seg = cast(dict[str, Any], seg)

        start = seg.get("start")
        end = seg.get("end")
        speaker = seg.get("speaker")

        if not _is_number(start):
            issues.append(f"Segment {idx} 'start' must be a number")
            continue
        if not _is_number(end):
            issues.append(f"Segment {idx} 'end' must be a number")
            continue
        if not isinstance(speaker, str) or not speaker.strip():
            issues.append(f"Segment {idx} 'speaker' must be a non-empty string")
            continue

        start_f = float(cast(float | int, start))
        end_f = float(cast(float | int, end))
        if end_f <= start_f:
            issues.append(f"Segment {idx} end must be greater than start")
            continue

        if prev_start is not None and start_f < prev_start:
            issues.append(f"Segment {idx} start time is out of order")
        prev_start = start_f

        speakers.add(speaker.strip())
        total_duration += end_f - start_f

    if issues:
        _emit(f"✗ Diarization validation failed ({len(issues)} issue(s))")
        display_cap = max_issues_display if verbose else min(5, max_issues_display)
        for issue in issues[:display_cap]:
            _emit(f"  - {issue}")
        remaining = len(issues) - display_cap
        if remaining > 0:
            _emit(f"  ... and {remaining} more (use -v for more)")
        _record(status="failed", issues=len(issues), message=issues[0] if issues else None)
        return False

    _record(
        status="passed",
        segments=len(segments_raw),
        speakers=len(speakers),
        duration_sec=total_duration,
        issues=0,
    )
    if not quiet:
        _emit("✓ Diarization file is valid")
    return True


def batch_validate_diarization(
    transcripts_root: Path,
    limit: int | None = None,
    *,
    verbose: bool = False,
    show_progress: bool = True,
    console: Console | None = None,
    quiet: bool | None = None,
) -> tuple[int, dict]:
    """Validate diarization outputs under transcripts_root/speaker_diarization.

    Returns (failures, summary_dict).
    """

    console = console or Console()
    quiet = show_progress if quiet is None else quiet
    dia_root = transcripts_root / "speaker_diarization"

    console.print(f"Scanning diarization outputs in {dia_root}...")
    if not dia_root.exists():
        console.print("No diarization directory found")
        return 0, {
            "root": str(dia_root),
            "files_found": 0,
            "files_evaluated": 0,
            "passed": 0,
            "failed": 0,
            "backends": [],
            "status": "missing",
        }

    diarization_files = sorted(dia_root.glob("*/*/speakers.json"))
    total_found = len(diarization_files)
    if not total_found:
        console.print("No speakers.json files found")
        return 0, {
            "root": str(dia_root),
            "files_found": 0,
            "files_evaluated": 0,
            "passed": 0,
            "failed": 0,
            "backends": [],
            "status": "empty",
        }

    console.print(f"Found {total_found} diarization file(s)")

    if limit:
        diarization_files = diarization_files[:limit]
        console.print(f"Limiting to {len(diarization_files)} file(s)\n")

    successes = 0
    failures = 0
    total_segments = 0
    total_speakers = 0
    total_duration = 0.0
    failure_details: list[dict[str, Any]] = []
    backend_stats: dict[str, dict[str, int]] = {}

    progress_columns = [
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TimeElapsedColumn(),
    ]

    with Progress(
        *progress_columns, console=console, transient=True, disable=not show_progress
    ) as progress:
        task = progress.add_task("Validating diarization", total=len(diarization_files))

        for path in diarization_files:
            try:
                backend = path.parent.parent.name
                rel_path = str(path.relative_to(dia_root))
            except Exception:
                backend = path.parent.parent.name if path.parent.parent else "unknown"
                rel_path = path.name

            stats = backend_stats.setdefault(backend, {"total": 0, "passed": 0, "failed": 0})
            stats["total"] += 1

            summary: dict[str, Any] = {}
            success = validate_diarization_file(
                path,
                quiet=quiet,
                verbose=verbose,
                summary=summary,
            )

            if success:
                successes += 1
                stats["passed"] += 1
                total_segments += summary.get("segments", 0) or 0
                total_speakers += summary.get("speakers", 0) or 0
                total_duration += summary.get("duration_sec", 0.0) or 0.0
            else:
                failures += 1
                stats["failed"] += 1
                failure_details.append(
                    {
                        "path": rel_path,
                        "backend": backend,
                        "message": summary.get("message"),
                        "issues": summary.get("issues"),
                    }
                )

            progress.advance(task)

    total_files = successes + failures
    pass_rate = (successes / total_files * 100) if total_files else 0.0

    console.print("\n" + "=" * 70)
    console.print(
        f"Diarization results: {successes}/{total_files} passed ({pass_rate:.1f}%), {failures} failed"
    )

    if successes:
        avg_segments = total_segments / successes if successes else 0
        avg_speakers = total_speakers / successes if successes else 0
        avg_duration = total_duration / successes if successes else 0.0
        console.print(
            f"Segments (passed files): {total_segments:,} total | avg {avg_segments:.1f} per file"
        )
        console.print(
            f"Speakers (passed files): {total_speakers:,} total | avg {avg_speakers:.1f} per file"
        )
        console.print(
            f"Duration (passed files): {total_duration:.1f}s total | avg {avg_duration:.1f}s per file"
        )

    if failure_details:
        console.print("\nFailed diarization files (first 5):")
        for detail in failure_details[:5]:
            reason = detail.get("message") or "see details"
            issue_count = detail.get("issues")
            if issue_count:
                reason = f"{reason} [{issue_count} issue(s)]"
            console.print(f"  - {detail['path']}: {reason}")
        if len(failure_details) > 5:
            console.print(f"  ... and {len(failure_details) - 5} more")

    if backend_stats:
        console.print("\nDiarization backend summary:")
        for backend in sorted(backend_stats):
            stats = backend_stats[backend]
            total = stats["total"]
            passed = stats["passed"]
            failed = stats["failed"]
            backend_rate = (passed / total * 100) if total else 0.0
            console.print(
                f"  {backend}: {passed}/{total} passed ({backend_rate:.1f}%), {failed} failed"
            )

    summary = {
        "root": str(dia_root),
        "files_found": total_found,
        "files_evaluated": len(diarization_files),
        "passed": successes,
        "failed": failures,
        "status": "ok" if failures == 0 else "issues",
        "backends": [
            {"name": backend, **stats} for backend, stats in sorted(backend_stats.items())
        ],
    }

    if successes:
        summary.update(
            {
                "segments_total": total_segments,
                "segments_avg": (total_segments / successes) if successes else 0,
                "speakers_total": total_speakers,
                "speakers_avg": (total_speakers / successes) if successes else 0,
                "duration_total_sec": total_duration,
                "duration_avg_sec": (total_duration / successes) if successes else 0.0,
            }
        )
    if failure_details:
        summary["failure_samples"] = failure_details[:5]

    return failures, summary


def batch_validate(
    directory: Path,
    limit: int | None = None,
    *,
    verbose: bool = False,
    show_progress: bool = True,
    console: Console | None = None,
) -> int:
    """Batch validate transcripts under a directory.

    Returns the number of failed validations.
    """

    console = console or Console()

    console.print(f"Finding transcripts in {directory}...")
    transcript_files = list(directory.rglob("transcript.json"))

    if not transcript_files:
        console.print("No transcript.json files found")
        return 0

    console.print(f"Found {len(transcript_files)} transcript(s)")

    if limit:
        transcript_files = transcript_files[:limit]
        console.print(f"Limiting to {len(transcript_files)} file(s)\n")

    successes = 0
    failures = 0
    group_stats: dict[str, dict[str, int]] = {}
    failure_details: list[dict[str, Any]] = []
    total_segments = 0
    total_words = 0

    progress_columns = [
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TimeElapsedColumn(),
    ]

    with Progress(
        *progress_columns, console=console, transient=True, disable=not show_progress
    ) as progress:
        task = progress.add_task("Validating transcripts", total=len(transcript_files))

        for path in transcript_files:
            if directory in path.parents:
                rel_parts = path.relative_to(directory).parts
                group = rel_parts[0] if rel_parts else str(directory.name)
                rel_path = str(path.relative_to(directory))
            else:
                group = path.parent.name
                rel_path = path.name

            stats = group_stats.setdefault(group, {"total": 0, "passed": 0, "failed": 0})
            stats["total"] += 1

            summary: dict[str, Any] = {}
            success = validate_single_file(
                path,
                verbose=verbose,
                quiet=show_progress,
                summary=summary,
            )

            if success:
                successes += 1
                stats["passed"] += 1
                total_segments += summary.get("segments", 0) or 0
                total_words += summary.get("words", 0) or 0
            else:
                failures += 1
                stats["failed"] += 1
                failure_details.append(
                    {
                        "path": rel_path,
                        "group": group,
                        "message": summary.get("message"),
                        "issues": summary.get("issues"),
                    }
                )

            progress.advance(task)

    total_files = successes + failures
    pass_rate = (successes / total_files * 100) if total_files else 0.0

    console.print("\n" + "=" * 70)
    console.print(
        f"Results: {successes}/{total_files} passed ({pass_rate:.1f}%), {failures} failed"
    )

    if successes:
        avg_segments = total_segments / successes if successes else 0
        avg_words = total_words / successes if successes else 0
        console.print(
            f"Segments (passed files): {total_segments:,} total | avg {avg_segments:.1f} per file"
        )
        console.print(f"Words (passed files): {total_words:,} total | avg {avg_words:.1f} per file")

    if failure_details:
        console.print("\nFailed files (first 5):")
        for detail in failure_details[:5]:
            reason = detail.get("message") or "see details"
            issue_count = detail.get("issues")
            if issue_count:
                reason = f"{reason} [{issue_count} issue(s)]"
            console.print(f"  - {detail['path']}: {reason}")
        if len(failure_details) > 5:
            console.print(f"  ... and {len(failure_details) - 5} more")

    if group_stats:
        console.print("\nGroup summary:")
        for group in sorted(group_stats):
            stats = group_stats[group]
            total = stats["total"]
            passed = stats["passed"]
            failed = stats["failed"]
            group_pass_rate = (passed / total * 100) if total else 0.0
            console.print(
                f"  {group}: {passed}/{total} passed ({group_pass_rate:.1f}%), {failed} failed"
            )

    return failures


__all__ = [
    "batch_validate",
    "validate_conversion",
    "validate_shared_schema",
    "validate_single_file",
    "load_json",
]
