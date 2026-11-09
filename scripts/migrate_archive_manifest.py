"""Add AAC columns to a pre-AAC archive manifest; dry-run unless --apply is given.

Run as ``uv run python -m scripts.migrate_archive_manifest /path/to/archived.csv``.
This explicit upgrade never runs from ordinary archive readers or writers.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import stat
from pathlib import Path

from besedy.commands.catalog.archive import (
    ArchivedManifestWriter,
    aac_manifest_values,
    catalog_ingest_lock,
    manifest_lock,
)
from besedy.lib.catalog.manager import require_csv_columns
from besedy.lib.data.atomic_io import atomic_path


def _require_regular_manifest(path: Path) -> None:
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f"Choose a regular manifest file, not a symlink or directory: {path}")


def migrate_archive_manifest(path: Path, *, apply: bool = False) -> dict[str, object]:
    """Validate a known manifest and optionally append its missing AAC columns."""
    path = Path(os.path.abspath(path.expanduser()))
    # Refuse a named symlink before the lock helpers resolve its target.
    _require_regular_manifest(path)
    with catalog_ingest_lock(path), manifest_lock(path):
        _require_regular_manifest(path)
        current_columns = ArchivedManifestWriter.FIELDNAMES
        aac_columns = list(aac_manifest_values(None, None, None))
        with path.open(encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle, strict=True)
            columns = next(reader, [])
            current = set(columns) == set(current_columns)
            required = (
                current_columns
                if current
                else [column for column in current_columns if column not in aac_columns]
            )
            require_csv_columns(columns, required, path=path)
            rows = []
            for index, row in enumerate(reader, start=2):
                if len(row) != len(columns):
                    raise ValueError(
                        f"{path} CSV record {index} has {len(row)} cells; expected {len(columns)}"
                    )
                rows.append(row)

        added = [] if current else aac_columns
        plan: dict[str, object] = {
            "apply": apply,
            "manifest": str(path),
            "rows": len(rows),
            "add_columns": added,
        }
        if apply and added:
            with atomic_path(path, follow_symlinks=False) as temporary:
                with temporary.open("w", encoding="utf-8", newline="") as handle:
                    writer = csv.writer(handle)
                    writer.writerow([*columns, *added])
                    for row in rows:
                        writer.writerow([*row, *([""] * len(added))])
        return plan


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="Concrete archived CSV file to upgrade")
    parser.add_argument("--apply", action="store_true", help="Apply the reviewed header upgrade")
    args = parser.parse_args(argv)
    try:
        plan = migrate_archive_manifest(args.manifest, apply=args.apply)
    except (OSError, ValueError, csv.Error) as exc:
        parser.exit(1, f"Error: {exc}\n")
    print(json.dumps(plan, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
