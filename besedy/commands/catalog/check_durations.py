"""Duration verification across all pipeline stages."""

from __future__ import annotations

import argparse
import csv
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)
from rich.table import Table

from besedy.commands.catalog.csv_utils import resolve_catalog_csv
from besedy.commands.catalog.metadata import format_duration
from besedy.config.settings import config
from besedy.core.cli_output import print_json_result
from besedy.core.paths import (
    extract_timestamp_from_catalog,
    resolve_catalogs_root,
    resolve_transcripts_parent,
)
from besedy.lib.data.encoding import load_json_with_fallback

# Default tolerance in seconds for duration comparisons
DEFAULT_TOLERANCE_SECONDS = 2.0


@dataclass
class DurationRecord:
    """Duration data for a single hash across all sources."""

    sha256: str
    filename: str = ""
    # CSV durations (in seconds, parsed from HH:MM:SS)
    csv_main: float | None = None
    csv_loudness: float | None = None
    csv_normalized: float | None = None
    csv_archived: float | None = None
    # Audio file durations (real decode)
    audio_original: float | None = None
    audio_staged: float | None = None
    audio_archived: float | None = None
    # Transcript durations
    transcript_durations: dict[str, float] = field(default_factory=dict)
    # File paths for probing
    path_original: Path | None = None
    path_staged: Path | None = None
    path_archived: Path | None = None


def parse_duration_hhmmss(duration_str: str | None) -> float | None:
    """Parse HH:MM:SS to seconds."""
    if not duration_str:
        return None
    try:
        parts = duration_str.strip().split(":")
        if len(parts) == 3:
            h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
            return float(h * 3600 + m * 60 + s)
        return float(duration_str)
    except (ValueError, TypeError):
        return None


def load_csv_durations(
    csv_path: Path,
    records: dict[str, DurationRecord],
    duration_attr: str,
    path_attr: str | None = None,
    path_column: str = "Full Path",
) -> int:
    """Load durations from a CSV file into records.

    Returns the number of entries loaded.
    """
    if not csv_path.exists():
        return 0

    count = 0
    with csv_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            sha256 = row.get("Hash", "")
            if not sha256:
                continue

            if sha256 not in records:
                records[sha256] = DurationRecord(sha256=sha256)

            record = records[sha256]

            # Set filename if not set
            if not record.filename:
                record.filename = row.get("Filename", "")

            # Parse and set duration
            duration = parse_duration_hhmmss(row.get("Duration"))
            setattr(record, duration_attr, duration)

            # Set path if requested
            if path_attr and path_column:
                path_str = row.get(path_column, "")
                if path_str:
                    setattr(record, path_attr, Path(path_str))

            count += 1

    return count


def find_transcript_durations(
    transcripts_root: Path,
    sha256: str,
) -> dict[str, float]:
    """Find transcript durations from meta.duration field across all workflows."""
    durations: dict[str, float] = {}

    if not transcripts_root.exists():
        return durations

    for workflow_dir in transcripts_root.iterdir():
        if not workflow_dir.is_dir():
            continue

        for model_dir in workflow_dir.iterdir():
            if not model_dir.is_dir():
                continue

            transcript_path = model_dir / sha256 / "transcript.json"
            if transcript_path.exists():
                try:
                    data = load_json_with_fallback(transcript_path)
                    duration = data.get("meta", {}).get("duration")
                    if duration is not None:
                        key = f"{workflow_dir.name}/{model_dir.name}"
                        durations[key] = float(duration)
                except Exception:
                    continue

    return durations


def probe_audio_duration(path: Path | None, ffprobe: str = "ffprobe") -> float | None:
    """Probe audio file for real decoded duration (accurate but slower).

    Note: We re-implement the probe here to handle edge cases like trailing
    commas in ffprobe output that the standard probe_decoded_duration misses.
    """
    import subprocess

    if path is None or not path.exists():
        return None

    cmd = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "csv=p=0",
        str(path),
    ]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
    except Exception:
        return None

    last_value: float | None = None
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            # Strip whitespace AND trailing commas (ffprobe csv output quirk)
            stripped = line.strip().rstrip(",")
            if not stripped or stripped in {"N/A", "nan"}:
                continue
            try:
                last_value = float(stripped)
            except ValueError:
                continue
    finally:
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            proc.kill()

    if proc.returncode not in (0, None):
        return None
    return last_value


def get_all_durations(record: DurationRecord) -> list[tuple[str, float]]:
    """Get all available durations for a record as (source, value) pairs."""
    durations: list[tuple[str, float]] = []

    if record.csv_main is not None:
        durations.append(("CSV Main", record.csv_main))
    if record.csv_loudness is not None:
        durations.append(("CSV Loudness", record.csv_loudness))
    if record.csv_normalized is not None:
        durations.append(("CSV Normalized", record.csv_normalized))
    if record.csv_archived is not None:
        durations.append(("CSV Archived", record.csv_archived))
    if record.audio_original is not None:
        durations.append(("Original Audio", record.audio_original))
    if record.audio_staged is not None:
        durations.append(("Staged WAV", record.audio_staged))
    if record.audio_archived is not None:
        durations.append(("Archived", record.audio_archived))

    for workflow, dur in record.transcript_durations.items():
        durations.append((f"Transcript ({workflow})", dur))

    return durations


def format_duration_diff(seconds: float) -> str:
    """Format a duration difference in human-readable form."""
    if seconds < 60:
        return f"{seconds:.1f}s"
    elif seconds < 3600:
        mins = seconds / 60
        return f"{mins:.1f}m"
    else:
        hours = seconds / 3600
        return f"{hours:.1f}h"


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'check-durations' subparser."""
    parser = subparsers.add_parser(
        "check-durations",
        help="Detect duration mismatches indicating corruption or incomplete processing",
        description="""\
Compares durations from: catalog CSV, staged audio files, and transcript metadata.
Mismatches may indicate truncated files, encoding errors, or incomplete transcription.

Example:
  catalog check-durations --tolerance 5.0     # Allow 5 second difference
  catalog check-durations --skip-audio-probe  # Fast check, metadata only
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Source catalog CSV. Default: audio_catalog.csv symlink.",
    )
    parser.add_argument(
        "--tolerance",
        type=float,
        default=2.0,
        help="Maximum allowed duration difference in seconds before flagging as mismatch. Accounts for rounding/encoding differences. Default: 2.0.",
    )
    parser.add_argument(
        "--skip-audio-probe",
        action="store_true",
        help="Don't decode actual audio files. Faster but only compares metadata from CSVs and transcripts.",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Show detailed comparison for all files, not just mismatches.",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format: text for human reading, json for scripting.",
    )
    parser.add_argument(
        "--ffprobe-binary",
        default="ffprobe",
        help="Path to ffprobe executable for audio probing.",
    )
    parser.set_defaults(func=handle_check_durations)
    return parser


def handle_check_durations(args: argparse.Namespace) -> int:
    """Verify durations across all pipeline stages."""
    console = Console()
    output_format = getattr(args, "format", "text")
    verbose = getattr(args, "verbose", False)
    skip_audio_probe = getattr(args, "skip_audio_probe", False)
    tolerance = getattr(args, "tolerance", DEFAULT_TOLERANCE_SECONDS)
    ffprobe = getattr(args, "ffprobe_binary", "ffprobe")

    # Resolve catalog CSV
    catalogs_root = resolve_catalogs_root()
    try:
        csv_path = resolve_catalog_csv(
            args.csv,
            purpose="check-durations",
            default_symlink=catalogs_root / "audio_catalog.csv",
        )
    except FileNotFoundError as e:
        if output_format == "json":
            print_json_result(
                name="check-durations",
                status="error",
                result={"error": str(e)},
            )
        else:
            console.print(f"[red]Error: {e}[/red]")
        return 1

    timestamp = extract_timestamp_from_catalog(csv_path.resolve())

    if not timestamp:
        if output_format == "json":
            print_json_result(
                name="check-durations",
                status="error",
                result={"error": "Could not extract timestamp from catalog filename"},
            )
        else:
            console.print("[red]Error: Could not extract timestamp from catalog[/red]")
        return 1

    # Derive paths for other CSVs
    catalog_dir = csv_path.parent
    loudness_csv = catalog_dir / f"audio_catalog_{timestamp}_loudness.csv"
    normalized_csv = catalog_dir / f"audio_catalog_{timestamp}_loudness_normalized.csv"
    archived_csv = catalog_dir / f"audio_catalog_{timestamp}_loudness_archived.csv"
    transcripts_parent = resolve_transcripts_parent()
    transcripts_root = transcripts_parent / f"{config.paths.transcripts_dir}_{timestamp}"

    if output_format == "text":
        console.print(f"\n[bold]Duration check for {csv_path.name}[/bold]")
        console.print(f"Timestamp: {timestamp}\n")
        console.print("Checking sources:")

    records: dict[str, DurationRecord] = {}
    source_counts: dict[str, int] = {}

    # Load main catalog
    count = load_csv_durations(
        csv_path,
        records,
        "csv_main",
        path_attr="path_original",
        path_column="Full Path",
    )
    source_counts["Main catalog"] = count
    if output_format == "text":
        status = "[green]OK[/green]" if count > 0 else "[yellow]N/A[/yellow]"
        console.print(f"  {status} Main catalog:     {count} entries")

    # Load loudness CSV
    count = load_csv_durations(loudness_csv, records, "csv_loudness")
    source_counts["Loudness CSV"] = count
    if output_format == "text":
        status = "[green]OK[/green]" if count > 0 else "[yellow]N/A[/yellow]"
        console.print(f"  {status} Loudness CSV:     {count} entries")

    # Load normalized CSV
    count = load_csv_durations(
        normalized_csv,
        records,
        "csv_normalized",
        path_attr="path_staged",
        path_column="Full Path",
    )
    source_counts["Normalized CSV"] = count
    if output_format == "text":
        status = "[green]OK[/green]" if count > 0 else "[yellow]N/A[/yellow]"
        console.print(f"  {status} Normalized CSV:   {count} entries")

    # Load archived CSV
    if archived_csv.exists():
        with archived_csv.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            archived_count = 0
            for row in reader:
                sha256 = row.get("Hash", "")
                if not sha256:
                    continue

                if sha256 not in records:
                    records[sha256] = DurationRecord(sha256=sha256)

                record = records[sha256]
                record.csv_archived = parse_duration_hhmmss(row.get("Duration"))

                # Archived files use "Compressed Path" column
                compressed_path = row.get("Compressed Path", "")
                if compressed_path:
                    record.path_archived = Path(compressed_path)

                archived_count += 1

        source_counts["Archived CSV"] = archived_count
        if output_format == "text":
            status = "[green]OK[/green]" if archived_count > 0 else "[yellow]N/A[/yellow]"
            console.print(f"  {status} Archived CSV:     {archived_count} entries")
    else:
        source_counts["Archived CSV"] = 0
        if output_format == "text":
            console.print("  [yellow]N/A[/yellow] Archived CSV:     not found")

    # Probe audio files (unless skipped)
    if not skip_audio_probe:
        # Collect files to probe
        files_to_probe: list[tuple[str, str, Path]] = []  # (sha256, attr, path)

        for sha256, record in records.items():
            if record.path_original and record.path_original.exists():
                files_to_probe.append((sha256, "audio_original", record.path_original))
            if record.path_staged and record.path_staged.exists():
                files_to_probe.append((sha256, "audio_staged", record.path_staged))
            if record.path_archived and record.path_archived.exists():
                files_to_probe.append((sha256, "audio_archived", record.path_archived))

        if files_to_probe and output_format == "text":
            console.print(f"\nProbing {len(files_to_probe)} audio files...")

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                TaskProgressColumn(),
                TimeElapsedColumn(),
                console=console,
            ) as progress:
                task = progress.add_task("Probing audio durations", total=len(files_to_probe))

                def probe_one(item: tuple[str, str, Path]) -> tuple[str, str, float | None]:
                    sha256, attr, path = item
                    duration = probe_audio_duration(path, ffprobe)
                    return (sha256, attr, duration)

                with ThreadPoolExecutor(max_workers=8) as executor:
                    futures = {executor.submit(probe_one, item): item for item in files_to_probe}

                    for future in as_completed(futures):
                        sha256, attr, duration = future.result()
                        if sha256 in records:
                            setattr(records[sha256], attr, duration)
                        progress.advance(task)

            # Count probed files by type
            original_count = sum(1 for r in records.values() if r.audio_original is not None)
            staged_count = sum(1 for r in records.values() if r.audio_staged is not None)
            archived_count = sum(1 for r in records.values() if r.audio_archived is not None)

            source_counts["Original audio"] = original_count
            source_counts["Staged WAV"] = staged_count
            source_counts["Archived audio"] = archived_count

            console.print(f"  [green]OK[/green] Original audio:   {original_count} files probed")
            console.print(f"  [green]OK[/green] Staged WAV:       {staged_count} files probed")
            console.print(f"  [green]OK[/green] Archived audio:   {archived_count} files probed")
    else:
        if output_format == "text":
            console.print("\n  [dim]Audio probing skipped (--skip-audio-probe)[/dim]")

    # Load transcript durations
    if transcripts_root.exists():
        transcript_count = 0
        workflows_found: set[str] = set()

        for sha256, record in records.items():
            durations = find_transcript_durations(transcripts_root, sha256)
            record.transcript_durations = durations
            transcript_count += len(durations)
            workflows_found.update(durations.keys())

        source_counts["Transcripts"] = transcript_count
        if output_format == "text":
            status = "[green]OK[/green]" if transcript_count > 0 else "[yellow]N/A[/yellow]"
            workflows_info = f" ({len(workflows_found)} workflows)" if workflows_found else ""
            console.print(f"  {status} Transcripts:      {transcript_count} files{workflows_info}")
    else:
        source_counts["Transcripts"] = 0
        if output_format == "text":
            console.print("  [yellow]N/A[/yellow] Transcripts:      not found")

    # Compare durations and find issues
    issues: list[tuple[str, DurationRecord, float]] = []

    for sha256, record in records.items():
        durations = get_all_durations(record)
        if len(durations) < 2:
            continue  # Need at least 2 sources to compare

        values = [d[1] for d in durations]
        min_d, max_d = min(values), max(values)
        diff = max_d - min_d

        if diff > tolerance:
            issues.append((sha256, record, diff))

    # Sort issues by difference (largest first)
    issues.sort(key=lambda x: x[2], reverse=True)

    # Output results
    if output_format == "json":
        result = {
            "catalog": str(csv_path),
            "timestamp": timestamp,
            "source_counts": source_counts,
            "total_hashes": len(records),
            "tolerance_seconds": tolerance,
            "issues_count": len(issues),
            "issues": [
                {
                    "hash": sha256,
                    "filename": record.filename,
                    "max_diff_seconds": diff,
                    "durations": {src: dur for src, dur in get_all_durations(record)},
                }
                for sha256, record, diff in issues
            ],
        }
        print_json_result(
            name="check-durations",
            status="error" if issues else "success",
            result=result,
        )
    else:
        console.print()

        if issues:
            console.print(
                f"[red bold]Found {len(issues)} files with duration discrepancies > {tolerance}s[/red bold]\n"
            )

            table = Table(show_header=True, header_style="bold")
            table.add_column("Hash (8)", style="cyan")
            table.add_column("Filename", max_width=30)
            table.add_column("CSV", justify="right")
            table.add_column("Original", justify="right")
            table.add_column("Staged", justify="right")
            table.add_column("Archived", justify="right")
            table.add_column("Transcript", justify="right")
            table.add_column("Max Diff", justify="right", style="red")

            for sha256, record, diff in issues[:20]:  # Limit to 20 rows
                # Get representative transcript duration
                transcript_dur = None
                if record.transcript_durations:
                    transcript_dur = next(iter(record.transcript_durations.values()))

                table.add_row(
                    sha256[:8],
                    record.filename[:30] if record.filename else "",
                    format_duration(record.csv_main) if record.csv_main else "-",
                    format_duration(record.audio_original) if record.audio_original else "-",
                    format_duration(record.audio_staged) if record.audio_staged else "-",
                    format_duration(record.audio_archived) if record.audio_archived else "-",
                    format_duration(transcript_dur) if transcript_dur else "-",
                    format_duration_diff(diff),
                )

            console.print(table)

            if len(issues) > 20:
                console.print(f"\n[dim]... and {len(issues) - 20} more issues[/dim]")

            console.print("\n[yellow]Run with --verbose to see all details[/yellow]")
        else:
            console.print(
                f"[green bold]All {len(records)} files have consistent durations[/green bold] "
                f"(tolerance: {tolerance}s)"
            )

        if verbose and not issues:
            # Show summary table for verbose mode
            console.print("\n[bold]Duration summary:[/bold]")
            table = Table(show_header=True, header_style="bold")
            table.add_column("Hash (8)", style="cyan")
            table.add_column("Filename", max_width=30)
            table.add_column("Duration", justify="right")
            table.add_column("Sources", justify="right")

            for sha256, record in list(records.items())[:50]:
                durations = get_all_durations(record)
                if durations:
                    avg_dur = sum(d[1] for d in durations) / len(durations)
                    table.add_row(
                        sha256[:8],
                        record.filename[:30] if record.filename else "",
                        format_duration(avg_dur),
                        str(len(durations)),
                    )

            console.print(table)
            if len(records) > 50:
                console.print(f"\n[dim]... showing first 50 of {len(records)} files[/dim]")

    return 1 if issues else 0
