"""Catalog merge command - combine two catalog CSVs."""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path

from besedy.core.paths import resolve_catalogs_root
from besedy.lib.catalog.manager import (
    get_iso8601_timestamp,
    load_csv,
    merge_catalogs,
    require_audio_hash_contract,
    resolve_hash_column,
    write_merged_csv,
)


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'merge' subparser."""
    parser = subparsers.add_parser(
        "merge",
        help="Combine two catalog CSVs, deduplicating by content hash",
        description="""\
Merges source2 into source1, keeping unique entries based on SHA-256 hash.
Useful for combining catalogs from different directories or time periods.

Example:
  catalog merge old_catalog.csv new_files.csv --output combined.csv
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "source1",
        type=Path,
        help="Base catalog CSV. Entries from this file are kept as-is.",
    )
    parser.add_argument(
        "source2",
        type=Path,
        help="Catalog to merge in. Only entries with new hashes are added.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output CSV path. Default: timestamped filename with symlink.",
    )
    parser.add_argument(
        "--encoding",
        default="utf-8",
        help="Character encoding for reading/writing CSV files. Default: utf-8.",
    )
    parser.add_argument(
        "--hash-column",
        default=None,
        help="Name of the hash column if non-standard. Auto-detects: 'hash', 'sha256', 'Hash'. Case-insensitive.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress informational output; only show warnings and errors.",
    )
    parser.set_defaults(func=handle_merge)
    return parser


def handle_merge(args: argparse.Namespace) -> int:
    """Merge two audio catalog CSV files."""
    LOGGER = logging.getLogger("audio_catalog.merge")
    level = logging.WARNING if args.quiet else logging.INFO
    logging.basicConfig(level=level, format="%(levelname)s: %(message)s")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    default_output = resolve_catalogs_root() / f"audio_catalog_{timestamp}.csv"
    output_path = args.output or default_output

    print(f"Merging {args.source2} into {args.source1}...")

    target_columns, target_rows = load_csv(args.source1, encoding=args.encoding)
    target_hash_column = resolve_hash_column(
        target_columns, args.source1, preferred=args.hash_column
    )

    source_columns, source_rows = load_csv(args.source2, encoding=args.encoding)
    source_hash_column = resolve_hash_column(
        source_columns, args.source2, preferred=args.hash_column
    )

    try:
        require_audio_hash_contract(
            target_columns,
            target_rows,
            path=args.source1,
            hash_column=target_hash_column,
        )
        require_audio_hash_contract(
            source_columns,
            source_rows,
            path=args.source2,
            hash_column=source_hash_column,
        )
    except ValueError as exc:
        print(
            f"Error: {exc}. Recreate untyped catalogs with 'catalog create' before merging.",
            file=sys.stderr,
        )
        return 1

    if source_hash_column != target_hash_column:
        LOGGER.info(
            "Aligning source hash column '%s' to target column '%s'",
            source_hash_column,
            target_hash_column,
        )

    all_columns = list(target_columns)
    for col in source_columns:
        if col not in all_columns:
            all_columns.append(col)

    merged_rows, appended_rows = merge_catalogs(
        source_rows=source_rows,
        target_rows=target_rows,
        columns=all_columns,
        source_hash_column=source_hash_column,
        target_hash_column=target_hash_column,
    )

    # Ensure added_at column exists in canonical position and backfill all rows
    current_timestamp = get_iso8601_timestamp()
    if "added_at" not in all_columns:
        # Insert after Duration (canonical position)
        if "Duration" in all_columns:
            idx = all_columns.index("Duration") + 1
            all_columns.insert(idx, "added_at")
        else:
            all_columns.append("added_at")

    # Backfill all rows (both existing and new) that lack added_at
    for row in merged_rows:
        if not row.get("added_at", "").strip():
            row["added_at"] = current_timestamp

    write_merged_csv(output_path, merged_rows, columns=all_columns, encoding=args.encoding)
    LOGGER.info(
        "Merged catalog written to %s with %d total rows",
        output_path,
        len(merged_rows),
    )
    print(f"Created {output_path}")
    print(f"  Source 1 rows: {len(target_rows)}")
    print(f"  Source 2 rows: {len(source_rows)}")
    print(f"  New rows added: {len(appended_rows)}")
    print(f"  Total rows: {len(merged_rows)}")

    return 0
