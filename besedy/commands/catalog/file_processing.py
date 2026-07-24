"""Shared file processing logic for catalog commands."""

from __future__ import annotations

import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
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

from besedy.commands.catalog.metadata import enrich_basic_records
from besedy.commands.catalog.system import detect_logical_cpus
from besedy.commands.catalog.ui import write_duplicates_csv
from besedy.lib.catalog.manager import (
    FileRecord,
    build_record_for_file,
    check_ffprobe,
)


@dataclass
class AddFilesResult:
    """Result of adding files to a catalog."""

    new_records: list[FileRecord]
    duplicate_records: list[FileRecord]
    errors: list[str]
    sidecar_warnings: list[str]


def add_files_to_catalog(
    input_files: list[Path],
    existing_hashes: set[str],
    hash_to_original_path: dict[str, str],
    *,
    existing_duplicate_paths: set[str] | None = None,
    ffprobe_binary: str = "ffprobe",
    ffprobe_timeout: int = 30,
    skip_enrich: bool = False,
    use_color: bool = True,
    scan_root: str = "",
) -> AddFilesResult:
    """Core logic for adding files to a catalog.

    Processes input files, identifies new vs duplicates, and enriches with ffprobe.

    Args:
        input_files: List of file paths to process.
        existing_hashes: Set of hashes already in the catalog.
        hash_to_original_path: Mapping of hash to original file path (for duplicates CSV).
        existing_duplicate_paths: Set of paths already in duplicates CSV (to skip re-processing).
        ffprobe_binary: Path to ffprobe binary.
        ffprobe_timeout: Timeout for ffprobe calls.
        skip_enrich: If True, skip ffprobe metadata enrichment.
        use_color: Whether to use colored output.
        scan_root: The root directory from which files were scanned.

    Returns:
        AddFilesResult containing new records, duplicates, errors, and warnings.
    """
    if existing_duplicate_paths is None:
        existing_duplicate_paths = set()
    new_records: list[FileRecord] = []
    duplicate_records: list[FileRecord] = []
    sidecar_warnings: list[str] = []
    new_hashes: set[str] = set()
    errors_encountered: list[str] = []

    console = Console()
    sorted_files = sorted(input_files)
    workers = min(max(1, detect_logical_cpus() - 1), len(sorted_files))

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TimeElapsedColumn(),
        console=console,
        transient=False,
    ) as progress:
        task = progress.add_task(
            f"Hashing {len(sorted_files)} files ({workers} workers)...",
            total=len(sorted_files),
        )

        # Process files in parallel
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_to_path = {
                executor.submit(build_record_for_file, file_path, scan_root): file_path
                for file_path in sorted_files
            }

            for future in as_completed(future_to_path):
                record, error, sidecar_warning = future.result()

                if error:
                    errors_encountered.append(error)
                    progress.advance(task)
                    continue
                assert record is not None
                if sidecar_warning:
                    sidecar_warnings.append(sidecar_warning)

                hash_value = record.hash
                record_path = str(record.full_path)

                if hash_value in existing_hashes:
                    # Only a duplicate if it's a different file path
                    original_path = hash_to_original_path.get(hash_value, "")
                    if record_path != original_path:
                        # Skip if already in duplicates CSV
                        if record_path not in existing_duplicate_paths:
                            duplicate_records.append(record)
                    # else: same file already in catalog, skip
                    progress.advance(task)
                    continue

                if hash_value in new_hashes:
                    # Duplicate within this batch (already added one)
                    # Skip if already in duplicates CSV
                    if record_path not in existing_duplicate_paths:
                        duplicate_records.append(record)
                    progress.advance(task)
                    continue

                new_records.append(record)
                new_hashes.add(hash_value)
                # Track for within-batch duplicate detection
                hash_to_original_path[hash_value] = record_path
                progress.advance(task)

    # Print any errors that occurred
    for error in errors_encountered:
        print(error, file=sys.stderr)

    # Enrich with ffprobe if available
    if not skip_enrich:
        have_ffprobe = check_ffprobe(ffprobe_binary)
        if have_ffprobe:
            # Enrich new records with metadata
            if new_records:
                enrich_basic_records(
                    new_records,
                    ffprobe=ffprobe_binary,
                    timeout=ffprobe_timeout,
                    use_color=use_color,
                )

            # Enrich duplicate records with metadata (for duplicates CSV)
            if duplicate_records:
                enrich_basic_records(
                    duplicate_records,
                    ffprobe=ffprobe_binary,
                    timeout=ffprobe_timeout,
                    use_color=use_color,
                )

    return AddFilesResult(
        new_records=new_records,
        duplicate_records=duplicate_records,
        errors=errors_encountered,
        sidecar_warnings=sidecar_warnings,
    )


def write_duplicates_report(
    duplicate_records: list[FileRecord],
    new_records: list[FileRecord],
    hash_to_original_path: dict[str, str],
    duplicates_csv_path: Path,
) -> int:
    """Write duplicates CSV from duplicate records.

    Args:
        duplicate_records: List of duplicate FileRecords.
        new_records: List of new FileRecords (for within-batch duplicates).
        hash_to_original_path: Mapping of hash to original file path.
        duplicates_csv_path: Path to write duplicates CSV.

    Returns:
        Number of duplicate entries written.
    """
    if not duplicate_records:
        return 0

    # Build structures for write_duplicates_csv
    duplicates: dict[str, list[FileRecord]] = defaultdict(list)
    first_by_hash: dict[str, FileRecord] = {}

    for record in duplicate_records:
        duplicates[record.hash].append(record)
        # Create minimal FileRecord for original (we only need full_path)
        if record.hash not in first_by_hash:
            original_path = hash_to_original_path.get(record.hash, "")
            if not original_path:
                # Check if original is in new_records (duplicate within batch)
                for new_rec in new_records:
                    if new_rec.hash == record.hash:
                        original_path = str(new_rec.full_path)
                        break
            first_by_hash[record.hash] = FileRecord(
                hash=record.hash,
                filename="",
                full_path=Path(original_path) if original_path else Path(),
                hash_file=Path(),
                exists=True,
                size_bytes=0,
                size_human="",
                status="",
                extension="",
            )

    return write_duplicates_csv(duplicates, first_by_hash, duplicates_csv_path)
