"""Catalog creation command - scan directory and create catalog CSV."""

from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

from rich.console import Console

from besedy.commands.catalog.file_processing import (
    add_files_to_catalog,
    write_duplicates_report,
)
from besedy.commands.catalog.symlink import (
    create_or_update_symlink,
    validate_symlink_can_be_created,
)
from besedy.commands.catalog.ui import (
    Ansi,
    color_text,
    print_duplicates,
    print_duration_summary,
)
from besedy.core.paths import resolve_catalogs_root
from besedy.lib.catalog.manager import (
    FileRecord,
    catalog_fieldnames,
    check_ffmpeg,
    check_ffprobe,
    collect_input_files,
    file_record_to_row,
    get_iso8601_timestamp,
    get_supported_audio_extensions,
)
from besedy.lib.data.atomic_io import atomic_path


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'create' subparser."""
    parser = subparsers.add_parser(
        "create",
        help="Scan a directory for audio files and create a catalog CSV",
        description="""\
Recursively finds audio files (mp3, wav, flac, m4a, opus, ogg, webm, aac) and
creates a CSV with columns: hash (SHA-256), path, duration, format, codec, etc.

Example:
  catalog create /mnt/recordings --output my_catalog.csv
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "directory",
        type=Path,
        help="Root directory to scan for audio files. Subdirectories are included.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output CSV path. Default: audio_catalog_<timestamp>.csv with 'audio_catalog.csv' symlink to latest.",
    )
    parser.add_argument(
        "--ffprobe-binary",
        default="ffprobe",
        help="Path to ffprobe executable for metadata extraction.",
    )
    parser.add_argument(
        "--ffprobe-timeout",
        type=int,
        default=10,
        help="Seconds to wait for metadata extraction per file. Files that timeout are skipped with a warning. Default: 10.",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable colored terminal output.",
    )
    parser.add_argument(
        "--no-symlink",
        action="store_true",
        help="Do not create or update any symlinks (catalog/duplicates).",
    )
    parser.add_argument(
        "--no-audio-filter",
        action="store_true",
        help="Process ALL files, not just audio extensions. Useful for video files with audio tracks.",
    )
    parser.set_defaults(func=handle_create)
    return parser


def handle_create(args: argparse.Namespace) -> int:
    """Generate an audio catalog from a directory tree."""
    directory = args.directory.expanduser()
    if not directory.is_dir():
        print(f"Error: '{directory}' is not a directory", file=sys.stderr)
        return 1

    use_color = sys.stdout.isatty() and not args.no_color
    console = Console(force_terminal=use_color)

    # Detect supported audio extensions
    supported_extensions: set[str] | None = None
    if not args.no_audio_filter:
        ffmpeg_binary = args.ffmpeg_binary if hasattr(args, "ffmpeg_binary") else "ffmpeg"
        if check_ffmpeg(ffmpeg_binary):
            try:
                supported_extensions = get_supported_audio_extensions(ffmpeg_binary)
                ext_list = ", ".join(sorted(supported_extensions))
                print(f"Audio extension filter enabled: {ext_list}")
            except RuntimeError as e:
                print(f"Warning: {e}. Audio filtering disabled.")
        else:
            print("Warning: ffmpeg not found, audio filtering disabled")

    # Collect all audio files
    console.print(f"[cyan]Scanning for audio files in:[/cyan] {directory}")
    input_files, warnings = collect_input_files(
        [directory], supported_extensions=supported_extensions
    )
    for warning in warnings:
        print(warning, file=sys.stderr)

    if not input_files:
        print(color_text("No audio files found in the specified directory", Ansi.RED, use_color))
        return 0

    print(f"Found {len(input_files)} audio files to process")
    print()

    # Check ffprobe before processing
    if not check_ffprobe(args.ffprobe_binary):
        error_msg = color_text(
            "ffprobe not found. Install ffmpeg for metadata extraction.",
            Ansi.RED,
            use_color,
        )
        print(error_msg)
        return 1

    # Prepare output path and validate symlink
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    default_csv = resolve_catalogs_root() / f"audio_catalog_{timestamp}.csv"
    catalog_csv_path = args.output or default_csv

    symlink_path = catalog_csv_path.parent / "audio_catalog.csv"
    need_symlink = not args.no_symlink and symlink_path != catalog_csv_path

    if need_symlink:
        try:
            validate_symlink_can_be_created(symlink_path, description="catalog")
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1

    # Process files using shared logic
    console.print("[cyan]Computing audio content hashes...[/cyan]")
    result = add_files_to_catalog(
        input_files=input_files,
        existing_hashes=set(),  # New catalog, nothing exists
        hash_to_original_path={},
        ffprobe_binary=args.ffprobe_binary,
        ffprobe_timeout=args.ffprobe_timeout,
        use_color=use_color,
        scan_root=str(directory),
    )

    # Set added_at timestamp for all records
    current_timestamp = get_iso8601_timestamp()
    for record in result.new_records:
        record.added_at = current_timestamp
    for record in result.duplicate_records:
        record.added_at = current_timestamp

    # Print sidecar warnings
    for warning in result.sidecar_warnings:
        console.print(f"[yellow]Warning:[/yellow] {warning}")

    # Statistics
    unique_count = len(result.new_records)
    duplicate_count = len(result.duplicate_records)
    total_count = unique_count + duplicate_count

    print()
    print(color_text("Statistics:", Ansi.CYAN, use_color))
    print(f"Total files processed: {total_count}")
    print(f"Unique files: {unique_count}")
    print(f"Duplicate files: {duplicate_count}")
    if result.errors:
        print(f"Errors: {len(result.errors)}")
    print()

    print(color_text("File types breakdown (unique files):", Ansi.CYAN, use_color))
    type_counter = Counter(record.extension or "no extension" for record in result.new_records)
    for extension, count in type_counter.most_common():
        label = extension if extension else "no extension"
        count_str = color_text(f"{count:3d}", Ansi.GREEN, use_color)
        print(f"  {label:<20}: {count_str}")

    print()
    print(color_text("Catalog will be written to:", Ansi.CYAN, use_color), catalog_csv_path)

    # Build duplicates structure for print_duplicates
    if result.duplicate_records:
        from collections import defaultdict

        duplicates: dict[str, list[FileRecord]] = defaultdict(list)
        first_by_hash: dict[str, FileRecord] = {}
        for record in result.duplicate_records:
            duplicates[record.hash].append(record)
        for record in result.new_records:
            if record.hash not in first_by_hash:
                first_by_hash[record.hash] = record
        print_duplicates(duplicates, first_by_hash, use_color=use_color)

    # Write catalog CSV atomically so a crash mid-write can't leave a
    # half-written catalog at its final path (atomic_path creates the parent
    # dir, fsyncs, and renames into place).
    columns = catalog_fieldnames(include_quality=False)

    total_seconds = 0.0
    with atomic_path(catalog_csv_path) as tmp_csv:
        with tmp_csv.open("w", newline="", encoding="utf-8") as handle:
            csv_writer = csv.DictWriter(handle, fieldnames=columns, quoting=csv.QUOTE_MINIMAL)
            csv_writer.writeheader()
            for record in result.new_records:
                csv_writer.writerow(file_record_to_row(record, columns))
                if record.duration_seconds:
                    total_seconds += record.duration_seconds

    print()
    print(color_text("Audio catalog saved to:", Ansi.CYAN, use_color), catalog_csv_path)
    if need_symlink:
        create_or_update_symlink(symlink_path, catalog_csv_path, description="catalog")

    # Write duplicates report if any duplicates found
    if result.duplicate_records:
        duplicates_csv_path = catalog_csv_path.with_name(catalog_csv_path.stem + "_duplicates.csv")
        # Build hash_to_original_path for duplicates report
        hash_to_path = {record.hash: str(record.full_path) for record in result.new_records}
        dup_count = write_duplicates_report(
            result.duplicate_records,
            result.new_records,
            hash_to_path,
            duplicates_csv_path,
        )
        print(
            color_text("Duplicates report saved to:", Ansi.CYAN, use_color),
            duplicates_csv_path,
        )
        print(f"  {dup_count} duplicate entries written")

        # Create symlink for duplicates
        duplicates_symlink = catalog_csv_path.parent / "audio_catalog_duplicates.csv"
        if not args.no_symlink and duplicates_symlink != duplicates_csv_path:
            try:
                validate_symlink_can_be_created(duplicates_symlink, description="duplicates")
                create_or_update_symlink(
                    duplicates_symlink, duplicates_csv_path, description="duplicates"
                )
            except RuntimeError as e:
                print(f"Warning: Could not create duplicates symlink: {e}")

    print_duration_summary(total_seconds)
    return 0
