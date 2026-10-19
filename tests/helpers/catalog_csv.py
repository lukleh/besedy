"""Catalog CSV fixtures built with the shared row serialization contract."""

import csv
from pathlib import Path

from besedy.lib.catalog.manager import FileRecord, catalog_fieldnames, file_record_to_row


def write_catalog_csv(
    records: list[FileRecord],
    csv_path: Path,
    *,
    include_quality: bool = False,
) -> None:
    """Write audio catalog records to a CSV file.

    Creates parent directories if needed. Uses UTF-8 encoding and minimal
    quoting for CSV compatibility.

    Args:
        records: List of FileRecord objects to write.
        csv_path: Output path for the CSV file.
        include_quality: If True, include audio quality columns in the output schema.
    """
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = catalog_fieldnames(include_quality=include_quality)
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        for record in records:
            writer.writerow(file_record_to_row(record, fieldnames))
