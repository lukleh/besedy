"""Loudness analysis command for audio catalogs."""

from __future__ import annotations

import argparse
import csv
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

from rich.console import Console
from rich.markup import escape as rich_escape
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

from besedy.commands.catalog.metadata import get_loudness_metrics
from besedy.commands.catalog.symlink import (
    create_or_update_symlink,
    validate_symlink_can_be_created,
)
from besedy.commands.catalog.system import detect_logical_cpus
from besedy.commands.catalog.ui import (
    Ansi,
    color_text,
)
from besedy.core.paths import extract_timestamp_from_catalog, resolve_catalogs_root
from besedy.lib.catalog.manager import check_ffmpeg, check_ffprobe, load_csv


@dataclass
class LoudnessRequest:
    csv: Path | None = None
    output: Path | None = None
    parallel: int | None = None
    overwrite: bool = False
    ffprobe_binary: str = "ffprobe"
    ffmpeg_binary: str = "ffmpeg"
    encoding: str = "utf-8"
    no_color: bool = False
    no_symlink: bool = False

    @classmethod
    def from_args(
        cls,
        args: argparse.Namespace | "LoudnessRequest",
    ) -> "LoudnessRequest":
        if isinstance(args, cls):
            return args
        return cls(
            csv=getattr(args, "csv", None),
            output=getattr(args, "output", None),
            parallel=getattr(args, "parallel", None),
            overwrite=bool(getattr(args, "overwrite", False)),
            ffprobe_binary=str(getattr(args, "ffprobe_binary", "ffprobe")),
            ffmpeg_binary=str(getattr(args, "ffmpeg_binary", "ffmpeg")),
            encoding=getattr(args, "encoding", "utf-8"),
            no_color=bool(getattr(args, "no_color", False)),
            no_symlink=bool(getattr(args, "no_symlink", False)),
        )


# Columns to add/update during loudness analysis
LOUDNESS_COLUMNS = [
    "sample_rate",
    "bit_depth",
    "channels",
    "bitrate_kbps",
    "codec_profile",
    "integrated_loudness_lufs",
    "true_peak_db",
    "loudness_range_lu",
    "input_thresh",
    "target_offset",
    "needs_normalization",
]


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'loudness' subparser."""
    parser = subparsers.add_parser(
        "loudness",
        help="Analyze audio loudness without modifying files",
        description="""\
Measures integrated loudness (LUFS), true peak, and loudness range for each
audio file. Results are saved to a new CSV with loudness columns added.

Required before stage-audio. Takes time as each file must be fully decoded.

Example:
  catalog loudness                # Analyze all files
  catalog loudness --parallel 16  # Override default workers
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
        "--output",
        type=Path,
        default=None,
        help="Output CSV path. Default: appends '_loudness' and timestamp to input filename, with audio_catalog_loudness.csv symlink.",
    )
    parser.add_argument(
        "--parallel",
        type=int,
        default=None,
        help="Parallel analysis workers. Higher values speed up processing on fast storage (SSD/NVMe). Default: all logical CPU cores.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing output file instead of appending.",
    )
    parser.add_argument(
        "--ffprobe-binary",
        default="ffprobe",
        help="Path to ffprobe executable.",
    )
    parser.add_argument(
        "--ffmpeg-binary",
        default="ffmpeg",
        help="Path to ffmpeg executable.",
    )
    parser.add_argument(
        "--encoding",
        default="utf-8",
        help="Character encoding for CSV files. Default: utf-8.",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable colored terminal output.",
    )
    parser.add_argument(
        "--no-symlink",
        action="store_true",
        help="Do not create or update the audio_catalog_loudness.csv symlink.",
    )
    parser.set_defaults(func=handle_loudness)
    return parser


def handle_loudness(
    args: argparse.Namespace | LoudnessRequest,
) -> int:
    """Analyze audio files and create loudness metrics CSV (slow: decodes audio).

    Processing Pipeline:
        Phase 1: Input Resolution - resolve catalog, validate timestamp, check binaries
        Phase 2: Incremental Setup - load existing data, prepare work items
        Phase 3: Parallel Execution - ThreadPoolExecutor with immediate CSV writes
        Phase 4: Backfill - write rows that weren't in work_items (preserves catalog)

    WHY incremental writes: Loudness analysis is slow (~real-time). If interrupted,
    we keep partial results. The symlink is created early so partial data is accessible.
    """
    request = LoudnessRequest.from_args(args)

    # === Phase 1: Input Resolution ===
    use_color = sys.stdout.isatty() and not request.no_color

    # Resolve input catalog
    if request.csv:
        catalog_path = request.csv.expanduser()
    else:
        symlink_path = resolve_catalogs_root() / "audio_catalog.csv"
        if symlink_path.exists() or symlink_path.is_symlink():
            catalog_path = symlink_path.resolve()
        else:
            print(
                f"Error: No CSV provided and default '{symlink_path}' not found.",
                file=sys.stderr,
            )
            return 1

    if not catalog_path.is_file():
        print(f"Error: Catalog not found at {catalog_path}", file=sys.stderr)
        return 1

    # Validate source catalog has a timestamp (pipeline coherence)
    timestamp = extract_timestamp_from_catalog(catalog_path.resolve())
    if not timestamp:
        print(
            f"Error: Catalog '{catalog_path.name}' lacks timestamp in filename.\n"
            "Expected format: audio_catalog_YYYYMMDD_HHMMSS.csv\n"
            "Use 'catalog create' to generate a properly timestamped catalog.",
            file=sys.stderr,
        )
        return 1

    # Check required binaries
    if not check_ffprobe(request.ffprobe_binary):
        error_msg = color_text(
            f"ffprobe not found at '{request.ffprobe_binary}'. Install ffmpeg.",
            Ansi.RED,
            use_color,
        )
        print(error_msg)
        return 1

    if not check_ffmpeg(request.ffmpeg_binary):
        error_msg = color_text(
            f"ffmpeg not found at '{request.ffmpeg_binary}'. Install ffmpeg.",
            Ansi.RED,
            use_color,
        )
        print(error_msg)
        return 1

    # === Phase 2: Incremental Processing Setup ===
    # Load catalog
    print(f"Loading catalog: {catalog_path}")
    try:
        columns, rows = load_csv(catalog_path, encoding=request.encoding)
    except Exception as exc:
        print(f"Error reading {catalog_path}: {exc}", file=sys.stderr)
        return 1

    if not rows:
        print("Catalog is empty, nothing to analyze.")
        return 0

    # Find hash column
    hash_column = "Hash"
    if hash_column not in columns:
        print("Error: 'Hash' column not found in catalog.", file=sys.stderr)
        return 1

    # Find path column
    path_column = "Full Path"
    if path_column not in columns:
        print("Error: 'Full Path' column not found in catalog.", file=sys.stderr)
        return 1

    print(f"Found {len(rows)} files to analyze")

    # Determine output path - preserve upstream timestamp, just append _loudness
    if request.output:
        output_path = request.output.expanduser()
    else:
        # Derive from input catalog name
        stem = catalog_path.stem
        # Remove any existing _loudness suffix to avoid duplication
        if stem.endswith("_loudness"):
            stem = stem[:-9]  # len("_loudness") == 9
        output_path = catalog_path.parent / f"{stem}_loudness.csv"

    # Pre-flight symlink validation
    symlink_path = output_path.parent / "audio_catalog_loudness.csv"
    need_symlink = not request.no_symlink and symlink_path != output_path

    if need_symlink:
        try:
            validate_symlink_can_be_created(symlink_path, description="loudness catalog")
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1

    # Load existing loudness data if available (for incremental processing)
    existing_loudness: dict[str, dict[str, str]] = {}
    if output_path.exists() and not request.overwrite:
        try:
            _, existing_rows = load_csv(output_path, encoding=request.encoding)
            for row in existing_rows:
                row_hash = row.get(hash_column, "").strip()
                # Consider it "done" if it has loudness data
                if row_hash and row.get("integrated_loudness_lufs", "").strip():
                    existing_loudness[row_hash] = row
            print(f"Found {len(existing_loudness)} files with existing loudness data")
        except Exception as exc:
            print(f"Warning: Could not load existing loudness data: {exc}")

    # Add loudness columns to output
    output_columns = list(columns)
    for col in LOUDNESS_COLUMNS:
        if col not in output_columns:
            output_columns.append(col)

    # Prepare work items: (row_index, row, file_path) - skip files with existing data
    work_items: list[tuple[int, dict[str, str], Path]] = []
    skipped_existing = 0
    for idx, row in enumerate(rows):
        file_path_str = row.get(path_column, "").strip()
        if not file_path_str:
            continue
        file_path = Path(file_path_str)
        if not file_path.exists():
            continue
        row_hash = row.get(hash_column, "").strip()
        if row_hash in existing_loudness:
            skipped_existing += 1
            continue
        work_items.append((idx, row, file_path))

    if skipped_existing > 0:
        print(f"Skipping {skipped_existing} files with existing loudness data")

    if not work_items:
        print("All files already have loudness data. Nothing to analyze.")
        return 0

    print(f"Analyzing {len(work_items)} files for loudness...")

    # === Phase 3: Parallel Execution ===
    # Process files with parallel workers
    cpu_limit = max(1, detect_logical_cpus())
    parallel_limit = request.parallel if request.parallel is not None else cpu_limit
    workers = min(cpu_limit, len(work_items), max(1, parallel_limit))
    console = Console(force_terminal=use_color)
    console.print(f"[cyan]Using {workers} worker(s) for loudness analysis[/cyan]")

    # Track processed rows and errors
    processed_indices: set[int] = set()
    errors: list[tuple[int, str, str]] = []
    write_lock = threading.Lock()
    analyzed_count = 0

    # Open CSV for incremental writes
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=output_columns, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        handle.flush()

        # Create symlink immediately so partial results are accessible
        if need_symlink:
            create_or_update_symlink(symlink_path, output_path, description="loudness catalog")

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            TextColumn("{task.completed}/{task.total}"),
            TimeElapsedColumn(),
            console=console,
            transient=False,
        ) as progress:
            task = progress.add_task("Analyzing loudness", total=len(work_items))

            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = {
                    executor.submit(
                        get_loudness_metrics,
                        file_path,
                        request.ffmpeg_binary,
                        request.ffprobe_binary,
                    ): (idx, row, file_path)
                    for idx, row, file_path in work_items
                }

                for future in as_completed(futures):
                    idx, row, file_path = futures[future]
                    try:
                        metrics, error = future.result()
                    except Exception as exc:
                        metrics = None
                        error = str(exc)

                    if error:
                        errors.append((idx, file_path.name, error))
                        progress.console.print(
                            f"  [red]\u2717[/red] {rich_escape(file_path.name)}: {error}",
                            highlight=False,
                        )
                    else:
                        progress.console.print(
                            f"  [green]\u2713[/green] {rich_escape(file_path.name)}",
                            highlight=False,
                        )

                    # Build result row
                    result_row = dict(row)
                    if metrics:
                        # All metrics are strings from AudioQualityMetrics
                        result_row["sample_rate"] = metrics.sample_rate or ""
                        result_row["bit_depth"] = metrics.bit_depth or ""
                        result_row["channels"] = metrics.channels or ""
                        result_row["bitrate_kbps"] = metrics.bitrate_kbps or ""
                        result_row["codec_profile"] = metrics.codec_profile or ""
                        result_row["integrated_loudness_lufs"] = (
                            metrics.integrated_loudness_lufs or ""
                        )
                        result_row["true_peak_db"] = metrics.true_peak_db or ""
                        result_row["loudness_range_lu"] = metrics.loudness_range_lu or ""
                        result_row["input_thresh"] = metrics.input_thresh or ""
                        result_row["target_offset"] = metrics.target_offset or ""
                        result_row["needs_normalization"] = (
                            "yes" if metrics.needs_normalization == "yes" else "no"
                        )

                    # Write immediately with lock for thread safety
                    with write_lock:
                        writer.writerow(result_row)
                        handle.flush()
                        processed_indices.add(idx)
                        if metrics:
                            analyzed_count += 1

                    progress.advance(task)

        # === Phase 4: Backfill non-work items ===
        # Write rows that weren't in work_items (missing files, existing data, etc.)
        # This preserves the complete catalog even with partial processing
        work_item_indices = {idx for idx, _, _ in work_items}
        for idx, row in enumerate(rows):
            if idx not in work_item_indices:
                row_hash = row.get(hash_column, "").strip()
                # Use existing loudness data if available
                if row_hash in existing_loudness:
                    writer.writerow(existing_loudness[row_hash])
                else:
                    writer.writerow(row)
        handle.flush()

    print()
    print(color_text("Loudness analysis saved to:", Ansi.CYAN, use_color), output_path)
    print(f"  Analyzed: {analyzed_count}")
    if errors:
        print(f"  Errors: {len(errors)}")

    return 0
