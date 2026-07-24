"""Console UI helpers for catalog commands."""

from __future__ import annotations

import csv
from collections.abc import Sequence
from pathlib import Path

from besedy.commands.catalog.default_paths import ALREADY_EXISTS_REASON
from besedy.lib.audio.types import PreparedEntry, SkippedEntry
from besedy.lib.catalog.manager import METADATA_TAG_COLUMNS, FileRecord

# Canonical column order for duplicates CSV
DUPLICATES_CSV_COLUMNS = (
    "Hash",
    "Original Path",
    "Duplicate Path",
    "Scan Root",
    "Size (bytes)",
    "Size (human)",
    "Duration",
    "added_at",
    *METADATA_TAG_COLUMNS,
)


class Ansi:
    """ANSI color codes for terminal output."""

    GREEN = "\033[0;32m"
    YELLOW = "\033[1;33m"
    CYAN = "\033[0;36m"
    RED = "\033[0;31m"
    RESET = "\033[0m"


def color_text(text: str, color: str, enabled: bool) -> str:
    """Wrap text in ANSI color codes if enabled."""

    return f"{color}{text}{Ansi.RESET}" if enabled else text


def print_duplicates(
    duplicates: dict[str, list[FileRecord]],
    first_by_hash: dict[str, FileRecord],
    *,
    use_color: bool,
) -> None:
    """Print duplicate files found during catalog creation."""

    if not duplicates:
        return
    print()
    print(color_text("Duplicate files found:", Ansi.YELLOW, use_color))
    print()
    for hash_value in sorted(duplicates):
        original = first_by_hash[hash_value]
        print(f"Hash: {hash_value[:16]}...")
        print(f"  Original: {original.full_path}")
        for duplicate in duplicates[hash_value]:
            print(f"  Duplicate: {duplicate.full_path}")
        print()


def print_duration_summary(total_seconds: float) -> None:
    """Print a summary of total audio duration."""

    if total_seconds <= 0:
        return
    seconds = int(round(total_seconds))
    hours = seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = seconds % 60
    days = hours // 24
    remaining_hours = hours % 24

    print("\n" + "=" * 50)
    print("TOTAL DURATION OF ALL AUDIO FILES:")
    if days > 0:
        print(f"  {days} days, {remaining_hours} hours, {minutes} minutes, {secs} seconds")
    print(f"  {hours:,} hours, {minutes} minutes, {secs} seconds")
    print(f"  {seconds:,} total seconds")
    print("=" * 50)


def has_error_skips(skipped: Sequence[SkippedEntry]) -> bool:
    """Return True when skipped rows include real errors, not resume/no-op skips."""

    return any(entry.reason != ALREADY_EXISTS_REASON for entry in skipped)


def print_workflow_summary(
    staged: Sequence[PreparedEntry],
    skipped: Sequence[SkippedEntry],
    workflow_failures: Sequence[tuple[str, int]],
) -> None:
    """Summarise workflow outcomes without implying work ran when it didn't."""

    print("\n=== Summary ===")
    print(f"Staged files: {len(staged)}")
    if staged:
        symlinked = sum(1 for entry in staged if entry.action == "symlink")
        converted = sum(1 for entry in staged if entry.action == "convert")
        reused = sum(1 for entry in staged if entry.action == "existing")
        normalized = sum(1 for entry in staged if entry.action == "convert" and entry.normalized)
        print(f"  Symlinks: {symlinked}")
        print(
            f"  Conversions: {converted} "
            f"(normalized: {normalized}, plain: {converted - normalized})"
        )
        print(f"  Reused: {reused}")
    if skipped:
        print("Skipped rows:")
        for entry in skipped:
            print(f"  - {entry.sha256}: {entry.reason} ({entry.source})")
    if workflow_failures:
        print("Workflow failures:")
        for label, code in workflow_failures:
            print(f"  - {label} (exit code {code})")
        return

    if has_error_skips(skipped):
        if staged:
            print("Workflows completed with skipped rows; command will exit with status 1.")
        else:
            print("No workflows completed successfully; command will exit with status 1.")
    elif staged:
        print("All workflows completed successfully.")
    elif skipped:
        print("No workflows executed; all entries were skipped.")
    else:
        print("No workflows were queued.")


def write_duplicates_csv(
    duplicates: dict[str, list[FileRecord]],
    first_by_hash: dict[str, FileRecord],
    output_path: Path,
) -> int:
    """Write duplicate files report to CSV.

    Returns:
        Number of duplicate entries written (excludes originals).
    """
    if not duplicates:
        return 0

    columns = list(DUPLICATES_CSV_COLUMNS)
    count = 0

    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()

        for hash_value in sorted(duplicates):
            original = first_by_hash[hash_value]
            # Handle unknown original path (Path("") → "." or sentinel values)
            original_path_str = str(original.full_path)
            if original_path_str in (".", "/unknown", ""):
                original_path_str = ""
            for duplicate in duplicates[hash_value]:
                writer.writerow(
                    {
                        "Hash": hash_value,
                        "Original Path": original_path_str,
                        "Duplicate Path": str(duplicate.full_path),
                        "Scan Root": duplicate.scan_root,
                        "Size (bytes)": duplicate.size_bytes,
                        "Size (human)": duplicate.size_human,
                        "Duration": duplicate.duration,
                        "added_at": duplicate.added_at,
                        **{col: getattr(duplicate, col, "") for col in METADATA_TAG_COLUMNS},
                    }
                )
                count += 1

    return count
