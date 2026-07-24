"""Catalog add command - incrementally add new files to existing catalog."""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from besedy.commands.catalog.file_processing import (
    AddFilesResult,
    add_files_to_catalog,
    write_duplicates_report,
)
from besedy.commands.catalog.symlink import (
    create_or_update_symlink,
    validate_symlink_can_be_created,
)
from besedy.commands.catalog.ui import DUPLICATES_CSV_COLUMNS
from besedy.core.paths import resolve_catalogs_root
from besedy.lib.catalog.manager import (
    append_csv,
    check_ffmpeg,
    check_ffprobe,
    collect_input_files,
    file_record_to_row,
    get_iso8601_timestamp,
    get_supported_audio_extensions,
    load_csv,
    require_audio_hash_contract,
    resolve_hash_column,
)


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'add' subparser."""
    parser = subparsers.add_parser(
        "add",
        help="Incrementally add new audio files to an existing catalog",
        description="""\
Scans for new files and appends them to the catalog without re-processing
existing entries. Skips files whose hash already exists in the catalog.

Example:
  catalog add /mnt/new_recordings --csv audio_catalog.csv
  catalog add  # Re-scans Scan Root directories from existing catalog
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        help="Files/directories to scan. If omitted, uses unique 'Scan Root' values from the existing catalog.",
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Catalog CSV to update. Default: audio_catalog.csv symlink.",
    )
    parser.add_argument(
        "--encoding",
        default="utf-8",
        help="Character encoding for the catalog CSV. Default: utf-8.",
    )
    parser.add_argument(
        "--skip-enrich",
        action="store_true",
        help="Skip metadata extraction (duration, codec, etc.). Creates minimal entries with just hash and path.",
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
        help="Seconds to wait for metadata extraction per file. Default: 10.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Show each file as it's processed, including why files were skipped (already in catalog, not audio, etc.).",
    )
    parser.add_argument(
        "--no-audio-filter",
        action="store_true",
        help="Process ALL files, not just audio extensions. Useful for video files with audio tracks.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be added without updating the catalog or duplicates CSV.",
    )
    parser.add_argument(
        "--no-symlink",
        action="store_true",
        help="Do not create or update any symlinks (duplicates report).",
    )
    parser.set_defaults(func=handle_add)
    return parser


def handle_add(args: argparse.Namespace) -> int:
    """Append new file entries to an existing catalog CSV."""
    # Resolve catalog path
    if args.csv:
        catalog_path = args.csv.expanduser()
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
        print(f"Error: catalog not found at {catalog_path}", file=sys.stderr)
        return 1

    # Load existing catalog
    try:
        columns, existing_rows = load_csv(catalog_path, encoding=args.encoding)
    except Exception as exc:
        print(f"Error reading {catalog_path}: {exc}", file=sys.stderr)
        return 1

    try:
        hash_column = resolve_hash_column(columns, catalog_path, preferred="Hash")
        require_audio_hash_contract(
            columns,
            existing_rows,
            path=catalog_path,
            hash_column=hash_column,
        )
    except ValueError as exc:
        print(
            f"Error: {exc}. Recreate the catalog with 'catalog create' before catalog add.",
            file=sys.stderr,
        )
        return 1

    # Extract existing hashes and paths
    existing_hashes: set[str] = set()
    hash_to_original_path: dict[str, str] = {}
    for row in existing_rows:
        value = (row.get(hash_column, "") or "").strip()
        if value:
            existing_hashes.add(value)
            full_path = (row.get("Full Path", "") or "").strip()
            if full_path and value not in hash_to_original_path:
                hash_to_original_path[value] = full_path

    # Load existing duplicates CSV to skip already-known duplicates
    existing_duplicate_paths: set[str] = set()
    existing_duplicate_rows: list[dict[str, str]] = []
    duplicates_csv_path = catalog_path.with_name(catalog_path.stem + "_duplicates.csv")
    if duplicates_csv_path.is_file():
        try:
            _, dup_rows = load_csv(duplicates_csv_path, encoding=args.encoding)
            existing_duplicate_rows = dup_rows
            for row in dup_rows:
                dup_path = (row.get("Duplicate Path", "") or "").strip()
                if dup_path:
                    existing_duplicate_paths.add(dup_path)
            if existing_duplicate_paths:
                print(f"Loaded {len(existing_duplicate_paths)} existing duplicates from CSV")
        except Exception:
            pass  # If we can't load it, we'll just reprocess

    # Auto-detect paths if not provided: use unique Scan Root values from catalog
    if not args.paths:
        scan_roots: set[str] = set()
        for row in existing_rows:
            scan_root = (row.get("Scan Root", "") or "").strip()
            if scan_root:
                scan_roots.add(scan_root)

        if not scan_roots:
            print(
                "Error: No 'Scan Root' values found in catalog. Provide paths explicitly.",
                file=sys.stderr,
            )
            return 1

        # Validate directories exist
        valid_roots: list[Path] = []
        for root in sorted(scan_roots):
            root_path = Path(root)
            if root_path.is_dir():
                valid_roots.append(root_path)
            else:
                print(f"Warning: Scan root not found, skipping: {root}")

        if not valid_roots:
            print("Error: None of the scan roots exist.", file=sys.stderr)
            return 1

        print(f"Using {len(valid_roots)} scan root(s) from catalog:")
        for root in valid_roots:
            print(f"  {root}")
        args.paths = valid_roots

    # Detect supported audio extensions
    supported_extensions: set[str] | None = None
    if not args.no_audio_filter:
        ffmpeg_binary = args.ffmpeg_binary if hasattr(args, "ffmpeg_binary") else "ffmpeg"
        if check_ffmpeg(ffmpeg_binary):
            try:
                supported_extensions = get_supported_audio_extensions(ffmpeg_binary)
                ext_list = ", ".join(sorted(supported_extensions))
                print(f"Audio extension filter enabled: {ext_list}")
            except RuntimeError:
                pass
        else:
            print("Warning: ffmpeg not found, audio filtering disabled")

    # Check ffprobe before processing
    if not args.skip_enrich and not check_ffprobe(args.ffprobe_binary):
        print(
            f"ffprobe not found at '{args.ffprobe_binary}'. "
            "Install ffmpeg or rerun with --skip-enrich.",
            file=sys.stderr,
        )
        return 1

    # Process each scan root separately to assign correct Scan Root values
    all_new_records: list = []
    all_duplicate_records: list = []
    all_errors: list[str] = []
    all_sidecar_warnings: list[str] = []
    total_files_processed = 0

    for scan_path in args.paths:
        # Collect files for this specific path
        path_files, path_warnings = collect_input_files(
            [scan_path], supported_extensions=supported_extensions
        )
        for warning in path_warnings:
            print(warning, file=sys.stderr)

        if not path_files:
            continue

        total_files_processed += len(path_files)

        result = add_files_to_catalog(
            input_files=path_files,
            existing_hashes=existing_hashes,
            hash_to_original_path=hash_to_original_path,
            existing_duplicate_paths=existing_duplicate_paths,
            ffprobe_binary=args.ffprobe_binary,
            ffprobe_timeout=args.ffprobe_timeout,
            skip_enrich=args.skip_enrich,
            use_color=sys.stdout.isatty(),
            scan_root=str(scan_path),
        )

        # Aggregate results
        all_new_records.extend(result.new_records)
        all_duplicate_records.extend(result.duplicate_records)
        all_errors.extend(result.errors)
        all_sidecar_warnings.extend(result.sidecar_warnings)

        # Update tracking sets to handle cross-root duplicates
        for record in result.new_records:
            existing_hashes.add(record.hash)
            hash_to_original_path[record.hash] = str(record.full_path)

    if total_files_processed == 0:
        print("No files discovered to add.")
        return 0

    # Create combined result for rest of function
    result = AddFilesResult(
        new_records=all_new_records,
        duplicate_records=all_duplicate_records,
        errors=all_errors,
        sidecar_warnings=all_sidecar_warnings,
    )

    # Set added_at timestamp for all new and duplicate records
    current_timestamp = get_iso8601_timestamp()
    for record in result.new_records:
        record.added_at = current_timestamp
    for record in result.duplicate_records:
        record.added_at = current_timestamp

    # Warn if legacy catalog lacks added_at (new records cannot preserve timestamps)
    if "added_at" not in columns:
        print(
            "Warning: Catalog lacks 'added_at' column. New records' timestamps will be lost.",
            file=sys.stderr,
        )

    # Append new records to catalog
    if result.new_records and not args.dry_run:
        rows_to_append = [file_record_to_row(record, columns) for record in result.new_records]
        append_csv(catalog_path, rows_to_append, columns=columns, encoding=args.encoding)

    # Write duplicates CSV (merge existing + new)
    dup_count = 0
    new_dup_count = 0
    if (result.duplicate_records or existing_duplicate_rows) and not args.dry_run:
        duplicates_csv_path = catalog_path.with_name(catalog_path.stem + "_duplicates.csv")

        # Write new duplicates using write_duplicates_report, then merge with existing
        if result.duplicate_records:
            # Write new duplicates to a temp structure, then combine
            new_dup_count = write_duplicates_report(
                result.duplicate_records,
                result.new_records,
                hash_to_original_path,
                duplicates_csv_path,
            )

            # If we had existing rows, we need to prepend them
            if existing_duplicate_rows and new_dup_count > 0:
                # Read the newly written rows
                _, new_rows = load_csv(duplicates_csv_path, encoding=args.encoding)
                # Combine: existing + new
                combined_rows = existing_duplicate_rows + new_rows
                # Use canonical columns (handles legacy 5-column CSVs)
                dup_columns = list(DUPLICATES_CSV_COLUMNS)
                # Normalize rows: fill missing columns with empty string
                normalized_rows = [
                    {col: row.get(col, "") for col in dup_columns} for row in combined_rows
                ]
                with duplicates_csv_path.open("w", newline="", encoding="utf-8") as f:
                    writer = csv.DictWriter(f, fieldnames=dup_columns, quoting=csv.QUOTE_MINIMAL)
                    writer.writeheader()
                    writer.writerows(normalized_rows)
                dup_count = len(normalized_rows)
            else:
                dup_count = new_dup_count
        elif existing_duplicate_rows:
            # No new duplicates, but we have existing - keep them as-is
            dup_count = len(existing_duplicate_rows)

        if new_dup_count:
            print(
                f"Duplicates CSV updated: {duplicates_csv_path} ({new_dup_count} new, {dup_count} total)"
            )
            # Create symlink for duplicates
            duplicates_symlink = catalog_path.parent / "audio_catalog_duplicates.csv"
            if not args.no_symlink and duplicates_symlink != duplicates_csv_path:
                try:
                    validate_symlink_can_be_created(duplicates_symlink, description="duplicates")
                    create_or_update_symlink(
                        duplicates_symlink, duplicates_csv_path, description="duplicates"
                    )
                except RuntimeError as e:
                    print(f"Warning: Could not create duplicates symlink: {e}")

    # Print summary
    print(f"Catalog: {catalog_path}")
    print(f"Existing rows: {len(existing_rows)}")
    print(f"New files processed: {total_files_processed}")
    if args.dry_run:
        print(f"Rows to append: {len(result.new_records)}")
    else:
        print(f"Rows appended: {len(result.new_records)}")

    if result.new_records:
        print("Added:")
        for record in result.new_records:
            print(f"  {record.hash[:16]}... -> {record.full_path}")

    if result.duplicate_records:
        print(f"Duplicates: {len(result.duplicate_records)}")
        if args.verbose:
            for record in result.duplicate_records:
                print(f"  {record.hash[:16]}... -> {record.full_path}")

    if result.sidecar_warnings:
        print("Warnings:")
        for warning in result.sidecar_warnings:
            print(f"  {warning}")

    if args.dry_run:
        print("Dry run - no catalog updates written.")

    return 0
