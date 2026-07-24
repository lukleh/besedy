"""Find duplicate audio/video files by content hash."""

from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from rich.console import Console

from besedy.commands.catalog.csv_utils import resolve_catalog_csv
from besedy.commands.catalog.default_paths import get_default_catalog_symlink
from besedy.core.cli_output import print_json_result
from besedy.core.paths import derive_common_root
from besedy.lib.audio.types import format_size


def load_catalog_hashes(catalog_path: Path) -> dict[str, str]:
    """Load the audio catalog and return a mapping of hash -> full path."""
    catalog_hashes = {}
    with open(catalog_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            hash_value = row.get("Hash", "").strip()
            full_path = row.get("Full Path", "").strip()
            if hash_value and full_path:
                catalog_hashes[hash_value] = full_path
    return catalog_hashes


def find_hash_sidecar_files(root_dir: Path) -> list[Path]:
    """Recursively find all .audiohash files, excluding metadata directories."""
    sidecar_files = []
    for path in root_dir.rglob("*.audiohash"):
        # Skip macOS metadata files
        if path.name.startswith("._"):
            continue
        # Skip Synology metadata directories
        if "@eaDir" in path.parts:
            continue
        sidecar_files.append(path)
    return sidecar_files


def parse_hash_sidecar_file(sidecar_path: Path) -> tuple[str, Path] | None:
    """Parse a .audiohash file and return (hash, media_file_path) or None on error."""
    try:
        with open(sidecar_path, "r", encoding="utf-8") as f:
            content = f.read().strip()
            if not content:
                return None

            # Format: "[hash]  [filename]" (two spaces separator)
            parts = content.split("  ", 1)
            if len(parts) != 2:
                # Try single space as fallback
                parts = content.split(" ", 1)
                if len(parts) != 2:
                    return None

            hash_value = parts[0].strip()
            # Validate hash format (64 hex chars)
            if len(hash_value) != 64 or not all(
                c in "0123456789abcdef" for c in hash_value.lower()
            ):
                return None

            # Media file path is the sidecar file path without the extension
            media_path = sidecar_path.with_suffix("")
            return (hash_value.lower(), media_path)

    except (OSError, UnicodeDecodeError):
        return None


def get_file_size(path: Path) -> int:
    """Get file size in bytes, return 0 if file doesn't exist."""
    try:
        return path.stat().st_size
    except OSError:
        return 0


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'find-duplicates' subparser."""
    parser = subparsers.add_parser(
        "find-duplicates",
        help="Find files with identical audio content for deduplication",
        description="""\
Identifies files that share the same SHA-256 hash, meaning they have
byte-identical content. Useful for cleaning up copies and reclaiming storage.

Example:
  catalog find-duplicates                    # Find duplicates, output CSV
  catalog find-duplicates --delete --dry-run # Preview what would be deleted
  catalog find-duplicates --delete           # Actually delete duplicates
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "directory",
        type=Path,
        nargs="?",
        default=None,
        help="Directory to scan. If omitted, derives from catalog file paths.",
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=None,
        help="Path to the audio catalog CSV file. Default: audio_catalog.csv symlink.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output CSV file path. Default: duplicates_<timestamp>.csv.",
    )
    parser.add_argument(
        "--delete",
        action="store_true",
        help="Delete duplicate files instead of just listing them. Also removes associated sidecar files (.hash, etc.).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="With --delete: preview what would be removed without actually deleting. Safe way to verify before deletion.",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format: text for human reading, json for scripting.",
    )
    parser.set_defaults(func=handle_find_duplicates)
    return parser


def handle_find_duplicates(args: argparse.Namespace) -> int:
    """Find duplicate files by comparing content hashes."""
    console = Console()
    output_format = getattr(args, "format", "text")
    command_name = "find-duplicates"

    # Resolve catalog path first (needed to derive directory if not provided)
    try:
        catalog_path = resolve_catalog_csv(
            args.catalog,
            purpose="find-duplicates",
            default_symlink=get_default_catalog_symlink(),
        )
    except FileNotFoundError as e:
        if output_format == "json":
            print_json_result(
                name=command_name,
                status="error",
                result={"error": "catalog_not_found", "message": str(e)},
            )
        else:
            console.print(f"[red]Error:[/red] {e}")
        return 1

    # Load catalog
    if output_format == "text":
        console.print(f"Loading catalog from: {catalog_path}")
    catalog = load_catalog_hashes(catalog_path)
    if output_format == "text":
        console.print(f"  Found {len(catalog)} entries in catalog")

    # Determine directory to scan
    if args.directory is not None:
        directory = Path(args.directory)
    else:
        # Derive from catalog paths
        catalog_paths = list(catalog.values())
        directory = derive_common_root(catalog_paths)
        if directory is None:
            if output_format == "json":
                print_json_result(
                    name=command_name,
                    status="error",
                    result={
                        "error": "no_common_root",
                        "message": "Cannot derive common root from catalog paths. Please provide directory argument.",
                    },
                )
            else:
                console.print("[red]Error:[/red] Cannot derive common root from catalog paths.")
                console.print("Please provide the directory argument explicitly.")
            return 1
        if output_format == "text":
            console.print(f"  Derived scan directory: {directory}")

    # Validate directory
    if not directory.is_dir():
        if output_format == "json":
            print_json_result(
                name=command_name,
                status="error",
                result={"error": "directory_not_found", "path": str(directory)},
            )
        else:
            console.print(f"[red]Error:[/red] Directory not found: {directory}")
        return 1

    # Find all hash sidecar files
    if output_format == "text":
        console.print(f"\nScanning for hash sidecar files in: {directory}")
    sha256_files = find_hash_sidecar_files(directory)
    if output_format == "text":
        console.print(f"  Found {len(sha256_files)} sidecar files")

    # Parse hashes and build hash -> paths mapping
    if output_format == "text":
        console.print("\nParsing hashes...")
    hash_to_paths: dict[str, list[Path]] = defaultdict(list)
    path_to_sha256_files: dict[Path, list[Path]] = defaultdict(list)
    errors = 0

    for sha256_file in sha256_files:
        result = parse_hash_sidecar_file(sha256_file)
        if result:
            file_hash, media_path = result
            if media_path not in hash_to_paths[file_hash]:
                hash_to_paths[file_hash].append(media_path)
            path_to_sha256_files[media_path].append(sha256_file)
        else:
            errors += 1

    if output_format == "text":
        console.print(f"  Parsed successfully: {len(sha256_files) - errors}")
        if errors:
            console.print(f"  Parse errors: {errors}")

    # Count duplicate sidecar files
    dup_sidecar_count = sum(
        len(files) - 1 for files in path_to_sha256_files.values() if len(files) > 1
    )
    if dup_sidecar_count and output_format == "text":
        console.print(f"  Duplicate sidecar files (same media path): {dup_sidecar_count}")

    # Find duplicates (hashes with multiple paths)
    duplicates = {h: paths for h, paths in hash_to_paths.items() if len(paths) > 1}
    unique_count = len(hash_to_paths)
    duplicate_groups = len(duplicates)
    duplicate_files = sum(len(paths) - 1 for paths in duplicates.values())

    # Calculate potential space savings
    total_savings = 0
    for file_hash, paths in duplicates.items():
        size = get_file_size(paths[0])
        total_savings += size * (len(paths) - 1)

    if output_format == "text":
        console.print("\n[bold]=== Results ===[/bold]")
        console.print(f"Total unique hashes: {unique_count}")
        console.print(f"Duplicate groups: {duplicate_groups}")
        console.print(f"Total duplicate files: {duplicate_files}")
        console.print(f"Potential space savings: {format_size(total_savings)}")

    if not duplicates:
        if output_format == "text":
            console.print("\n[green]No duplicates found![/green]")
        elif output_format == "json":
            print_json_result(
                name=command_name,
                status="success",
                result={
                    "status": "success",
                    "duplicates_found": False,
                    "unique_hashes": unique_count,
                    "duplicate_groups": 0,
                    "duplicate_files": 0,
                    "potential_savings_bytes": 0,
                },
            )
        return 0

    if args.delete:
        # Delete mode
        dry_run = getattr(args, "dry_run", False)
        if output_format == "text":
            if dry_run:
                console.print(
                    "\n[bold yellow]=== DRY RUN (no files will be deleted) ===[/bold yellow]"
                )
            else:
                console.print("\n[bold red]=== DELETE MODE ===[/bold red]")
        deleted_count = 0
        deleted_size = 0
        delete_errors = []

        for file_hash, paths in sorted(duplicates.items()):
            sorted_paths = sorted(
                paths,
                key=lambda p: (str(p) != catalog.get(file_hash, ""), len(str(p))),
            )
            original_path = sorted_paths[0]

            for path in sorted_paths[1:]:
                try:
                    size = get_file_size(path)
                    if path.exists():
                        if dry_run:
                            deleted_size += size
                            deleted_count += 1
                            if output_format == "text":
                                console.print(f"  Would delete: {path}")
                        else:
                            path.unlink()
                            deleted_size += size
                            deleted_count += 1
                            if output_format == "text":
                                console.print(f"  Deleted: {path}")
                except OSError as e:
                    delete_errors.append(f"Failed to delete {path}: {e}")

                for sha256_file in path_to_sha256_files.get(path, []):
                    try:
                        if sha256_file.exists():
                            if dry_run:
                                if output_format == "text":
                                    console.print(f"  Would delete: {sha256_file}")
                            else:
                                sha256_file.unlink()
                                if output_format == "text":
                                    console.print(f"  Deleted: {sha256_file}")
                    except OSError as e:
                        delete_errors.append(f"Failed to delete {sha256_file}: {e}")

        if output_format == "text":
            console.print("\n[bold]=== Summary ===[/bold]")
            if dry_run:
                console.print(f"Files that would be deleted: {deleted_count}")
                console.print(f"Space that would be reclaimed: {format_size(deleted_size)}")
            else:
                console.print(f"Files deleted: {deleted_count}")
                console.print(f"Space reclaimed: {format_size(deleted_size)}")
            if delete_errors:
                console.print(f"\n[red]Errors ({len(delete_errors)}):[/red]")
                for err in delete_errors:
                    console.print(f"  {err}")
        elif output_format == "json":
            status = "success" if not delete_errors else "error"
            print_json_result(
                name=command_name,
                status=status,
                result={
                    "status": "success",
                    "mode": "dry_run" if dry_run else "delete",
                    "files_deleted": deleted_count,
                    "space_reclaimed_bytes": deleted_size,
                    "space_reclaimed_human": format_size(deleted_size),
                    "errors": delete_errors,
                },
            )

        return 1 if delete_errors else 0
    else:
        # Report mode - generate CSV
        if args.output:
            output_path = Path(args.output)
        else:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_path = Path(f"duplicates_{timestamp}.csv")

        if output_format == "text":
            console.print(f"\nWriting report to: {output_path}")

        csv_rows = []
        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(
                [
                    "Hash",
                    "GroupNum",
                    "DuplicatePath",
                    "DuplicateFilename",
                    "FileSize",
                    "SizeHuman",
                    "InCatalog",
                    "OriginalPath",
                ]
            )

            group_num = 0
            for file_hash, paths in sorted(duplicates.items()):
                group_num += 1
                sorted_paths = sorted(
                    paths,
                    key=lambda p: (str(p) != catalog.get(file_hash, ""), len(str(p))),
                )
                original_path = sorted_paths[0]

                for path in sorted_paths[1:]:
                    size = get_file_size(path)
                    in_catalog = catalog.get(file_hash, "") == str(path)
                    row = [
                        file_hash,
                        group_num,
                        str(path),
                        path.name,
                        size,
                        format_size(size),
                        "yes" if in_catalog else "no",
                        str(original_path),
                    ]
                    writer.writerow(row)
                    csv_rows.append(
                        {
                            "hash": file_hash,
                            "group_num": group_num,
                            "duplicate_path": str(path),
                            "duplicate_filename": path.name,
                            "file_size": size,
                            "size_human": format_size(size),
                            "in_catalog": in_catalog,
                            "original_path": str(original_path),
                        }
                    )

        if output_format == "text":
            console.print(f"\n[green]Done![/green] Report written to: {output_path}")
        elif output_format == "json":
            print_json_result(
                name=command_name,
                status="success",
                result={
                    "status": "success",
                    "mode": "report",
                    "output_file": str(output_path),
                    "unique_hashes": unique_count,
                    "duplicate_groups": duplicate_groups,
                    "duplicate_files": duplicate_files,
                    "potential_savings_bytes": total_savings,
                    "potential_savings_human": format_size(total_savings),
                    "duplicates": csv_rows,
                },
            )

        return 0
