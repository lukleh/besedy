"""Catalog merge command - combine two catalog CSVs."""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path

from besedy.core.paths import resolve_catalogs_root
from besedy.lib.catalog.manager import (
    catalog_fieldnames,
    load_csv,
    merge_catalogs,
    require_catalog_schema,
    write_merged_csv,
)
from besedy.lib.data.atomic_io import rewrite_lock


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

    # `--output` may name one of the sources (or a live catalog): hold its
    # rewrite lock from the read to the replace, as `catalog add` and
    # `catalog remove` do, so neither's rows are dropped in between.
    output_path = Path(output_path).expanduser()
    # The lock file sits next to the output, so its directory must exist
    # before the lock rather than only once write_merged_csv publishes.
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with rewrite_lock(output_path):
        return _merge_into(args, output_path, LOGGER)


def _merge_into(args: argparse.Namespace, output_path: Path, LOGGER: logging.Logger) -> int:
    target_columns, target_rows = load_csv(args.source1, encoding=args.encoding)
    source_columns, source_rows = load_csv(args.source2, encoding=args.encoding)
    try:
        require_catalog_schema(target_columns, target_rows, path=args.source1)
        require_catalog_schema(source_columns, source_rows, path=args.source2)
    except ValueError as exc:
        print(
            f"Error: {exc}. Recreate catalogs with 'catalog create' before merging.",
            file=sys.stderr,
        )
        return 1

    all_columns = catalog_fieldnames()
    merged_rows, appended_rows = merge_catalogs(
        source_rows=source_rows,
        target_rows=target_rows,
        columns=all_columns,
        source_hash_column="Hash",
        target_hash_column="Hash",
    )

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
