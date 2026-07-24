"""Catalog cleanup command - remove entries for missing source files and their derivatives."""

from __future__ import annotations

import argparse
from pathlib import Path

from besedy.commands.catalog.csv_utils import resolve_catalog_csv
from besedy.commands.catalog.default_paths import (
    get_default_archived_symlink,
    get_default_catalog_symlink,
    get_default_duplicates_symlink,
    get_default_loudness_symlink,
    get_default_normalized_symlink,
)
from besedy.core.cli_output import print_json_result
from besedy.core.paths import (
    resolve_transcripts_root,
)
from besedy.lib.catalog.cleaner import (
    CleanupPlan,
    build_cleanup_plan,
    detect_missing_originals,
    execute_cleanup,
    infer_staging_dir,
)
from besedy.lib.catalog.manager import (
    filter_catalog_rows,
    load_csv,
    resolve_hash_column,
    write_merged_csv,
)


def _load_catalog_entries(csv_path: Path) -> tuple[list[str], list[dict], list[tuple[str, str]]]:
    """Load catalog and extract (sha256, full_path) tuples.

    Returns:
        Tuple of (columns, rows, entries) where entries is [(sha256, full_path), ...].
    """
    columns, rows = load_csv(csv_path, encoding="utf-8")
    hash_column = resolve_hash_column(columns, csv_path, preferred="Hash")

    entries: list[tuple[str, str]] = []
    for row in rows:
        sha256 = (row.get(hash_column, "") or "").strip()
        full_path = (row.get("Full Path", "") or "").strip()
        if sha256:
            entries.append((sha256, full_path))

    return list(columns), rows, entries


def _format_dry_run_report(
    plan: CleanupPlan,
    catalog_count: int,
    normalized_count: int,
    verbose: bool = False,
) -> str:
    """Format a dry-run report for display."""
    lines = []

    lines.append("=" * 70)
    lines.append("CATALOG CLEAN - DRY RUN")
    lines.append("=" * 70)
    lines.append("")
    lines.append(f"Catalog:            {plan.catalog_csv.name} ({catalog_count} entries)")
    if plan.normalized_csv:
        lines.append(f"Normalized catalog: {plan.normalized_csv.name} ({normalized_count} entries)")
    lines.append("")

    if not plan.targets:
        lines.append("No missing source audio files found. Nothing to clean.")
        return "\n".join(lines)

    lines.append(f"Found {len(plan.targets)} entries with missing source audio:")
    lines.append("")

    if verbose:
        # Show detailed list
        max_hash_display = 12
        for target in plan.targets:
            hash_display = target.sha256[:max_hash_display] + "..."
            lines.append(f"  {hash_display}  {target.original_path}")
    else:
        # Show summary with first few
        for target in plan.targets[:5]:
            hash_display = target.sha256[:12] + "..."
            lines.append(f"  {hash_display}  {target.original_path}")
        if len(plan.targets) > 5:
            lines.append(f"  ... and {len(plan.targets) - 5} more")

    lines.append("")
    lines.append("Derivatives to remove:")
    lines.append(f"  - {plan.total_staged} staged WAV files")
    lines.append(f"  - {plan.total_transcript_dirs} transcript directories")
    lines.append(f"  - {plan.total_diarization_dirs} diarization directories")
    lines.append(f"  - {plan.total_sidecar_files} transcript sidecar files")

    if plan.potential_mount_issue:
        lines.append("")
        lines.append("WARNING: Potential mount issue detected!")
        lines.append("  The following parent directories do not exist:")
        for parent in plan.suspect_parent_dirs[:3]:
            lines.append(f"    - {parent}")
        if len(plan.suspect_parent_dirs) > 3:
            lines.append(f"    ... and {len(plan.suspect_parent_dirs) - 3} more")
        lines.append("")
        lines.append("  This may indicate an unmounted network drive.")
        lines.append("  Use --force to proceed anyway.")

    lines.append("")
    lines.append("To execute: just catalog clean --execute")
    lines.append("")

    return "\n".join(lines)


def _format_execution_report(
    plan: CleanupPlan,
    result,
    catalog_count: int,
    new_catalog_count: int,
) -> str:
    """Format an execution report for display."""
    lines = []

    lines.append("=" * 70)
    lines.append("CATALOG CLEAN - COMPLETED")
    lines.append("=" * 70)
    lines.append("")
    lines.append(f"Catalog entries: {catalog_count} -> {new_catalog_count}")
    lines.append(f"  - Removed: {result.hashes_removed} entries")
    if getattr(result, "hashes_failed", 0):
        lines.append(f"  - Failed: {result.hashes_failed} entries")
    lines.append("")
    lines.append("Derivatives removed:")
    lines.append(f"  - {result.staged_removed} staged WAV files")
    lines.append(f"  - {result.transcript_dirs_removed} transcript directories")
    lines.append(f"  - {result.diarization_dirs_removed} diarization directories")
    lines.append(f"  - {result.sidecar_files_removed} transcript sidecar files")

    if result.errors:
        lines.append("")
        lines.append(f"Errors ({len(result.errors)}):")
        for error in result.errors[:10]:
            lines.append(f"  - {error}")
        if len(result.errors) > 10:
            lines.append(f"  ... and {len(result.errors) - 10} more")

    lines.append("")

    return "\n".join(lines)


def _find_stale_sidecar_files(
    transcripts_root: Path,
    catalog_hashes: set[str],
) -> list[tuple[str, Path]]:
    """Find transcript sidecar files for hashes not in catalog.

    Handles both:
    - Direct structure: <transcripts_root>/<workflow>/<model>/<hash>/transcript.*
    - Timestamped structure: <transcripts_root>/transcripts_<ts>/<workflow>/<model>/<hash>/transcript.*

    Returns list of (hash, path) tuples for files to remove.
    """
    from besedy.core.paths import TRANSCRIPT_SIDECAR_EXTENSIONS
    from besedy.lib.catalog.cleaner import _get_transcript_search_roots

    stale_files: list[tuple[str, Path]] = []

    for search_root in _get_transcript_search_roots(transcripts_root):
        # Search pattern: <workflow>/<model>/<hash>/transcript.*
        for sidecar in search_root.glob("*/*/*/transcript.*"):
            if sidecar.suffix.lower() not in TRANSCRIPT_SIDECAR_EXTENSIONS:
                continue
            parts = sidecar.relative_to(search_root).parts
            if len(parts) != 4:
                continue
            file_hash = parts[2]
            if file_hash and file_hash not in catalog_hashes:
                stale_files.append((file_hash, sidecar))

    return stale_files


def _handle_prune_orphans(
    args: argparse.Namespace,
    *,
    emit_output: bool = True,
) -> tuple[int, str, dict]:
    """Remove stale transcript sidecar files (txt/srt/vtt) for hashes not in catalog.

    Returns:
        Tuple of (exit_code, status, result_dict) for JSON output.
    """
    output_format = getattr(args, "format", "text")
    verbose = getattr(args, "verbose", False)
    execute = getattr(args, "execute", False)
    command_name = "clean"

    # Resolve paths
    try:
        csv_path = resolve_catalog_csv(
            args.csv,
            purpose="clean --prune-orphans",
            default_symlink=get_default_catalog_symlink(),
        )
    except FileNotFoundError as e:
        msg = str(e)
        result = {
            "error": "catalog_csv_missing",
            "path": str(args.csv or get_default_catalog_symlink()),
            "message": msg,
        }
        if emit_output:
            if output_format == "json":
                print_json_result(name=command_name, status="error", result=result)
            else:
                print(msg)
        return 1, "error", result

    transcripts_root = resolve_transcripts_root()

    # Load catalog
    try:
        columns, rows, entries = _load_catalog_entries(csv_path)
    except Exception as e:
        msg = f"Failed to load catalog: {e}"
        result = {"error": "catalog_load_failed", "message": str(e)}
        if emit_output:
            if output_format == "json":
                print_json_result(name=command_name, status="error", result=result)
            else:
                print(msg)
        return 1, "error", result

    catalog_hashes = {sha256 for sha256, _ in entries}

    # Find stale transcript sidecar files
    stale_files = _find_stale_sidecar_files(transcripts_root, catalog_hashes)

    if not stale_files:
        result = {
            "status": "no_orphans",
            "catalog_entries": len(entries),
            "message": "No stale transcript sidecar files found",
        }
        if emit_output:
            if output_format == "json":
                print_json_result(name=command_name, status="success", result=result)
            else:
                print("No stale transcript sidecar files found. Nothing to prune.")
        return 0, "success", result

    # Group by hash for display
    stale_hashes = sorted(set(h for h, _ in stale_files))

    if not execute:
        # Dry run
        result = {
            "status": "dry_run",
            "catalog_entries": len(entries),
            "stale_hashes": stale_hashes,
            "stale_file_count": len(stale_files),
        }
        if emit_output:
            if output_format == "json":
                print_json_result(name=command_name, status="success", result=result)
            else:
                print("=" * 70)
                print("CATALOG CLEAN --prune-orphans - DRY RUN")
                print("=" * 70)
                print()
                print(f"Catalog entries: {len(entries)}")
                print(
                    f"Stale transcript sidecar files: {len(stale_files)} (for {len(stale_hashes)} hashes)"
                )
                print()
                if verbose:
                    for h, path in stale_files[:20]:
                        print(f"  - {path}")
                    if len(stale_files) > 20:
                        print(f"  ... and {len(stale_files) - 20} more")
                else:
                    print(f"Stale hashes: {', '.join(stale_hashes[:5])}")
                    if len(stale_hashes) > 5:
                        print(f"  ... and {len(stale_hashes) - 5} more")
                print()
                print("To execute: just catalog clean --prune-orphans --execute")
                print()
        return 0, "success", result

    # Execute deletions
    removed = 0
    errors = []
    for _, path in stale_files:
        try:
            path.unlink()
            removed += 1
        except Exception as e:
            errors.append(f"{path}: {e}")

    result = {
        "status": "completed",
        "stale_files_removed": removed,
        "errors": errors,
    }
    status = "success" if not errors else "error"
    if emit_output:
        if output_format == "json":
            print_json_result(name=command_name, status=status, result=result)
        else:
            print("=" * 70)
            print("CATALOG CLEAN --prune-orphans - COMPLETED")
            print("=" * 70)
            print()
            print(f"Removed {removed} stale transcript sidecar files")
            if errors:
                print(f"Errors: {len(errors)}")
                for err in errors[:5]:
                    print(f"  - {err}")
            print()

    return (1 if errors else 0), status, result


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'clean' subparser."""
    parser = subparsers.add_parser(
        "clean",
        help="Remove entries for missing files and delete orphaned outputs",
        description="""\
Finds catalog entries whose source files no longer exist (moved, deleted, or
unmounted). Can also delete their staged audio, transcripts, and subtitle files.

Example:
  catalog clean                           # Dry-run: show what would be deleted
  catalog clean --execute                 # Actually remove entries
  catalog clean --execute --prune-orphans # Also delete orphaned subtitle files
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
        "--csv-normalized",
        type=Path,
        default=None,
        help="Staged catalog (output of stage-audio). Default: audio_catalog_normalized.csv symlink.",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually perform deletions. Without this flag, only previews what would be deleted (safe dry-run).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Skip safety check for unmounted directories. Use when you're sure files are deleted, not just unmounted.",
    )
    parser.add_argument(
        "--prune-orphans",
        action="store_true",
        help="Also delete subtitle files (txt/srt/vtt) for hashes no longer in catalog. These are 'orphaned' when source is removed.",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Show detailed list of files to be deleted.",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format: text for human reading, json for scripting.",
    )
    parser.set_defaults(func=handle_clean)
    return parser


def handle_clean(args: argparse.Namespace) -> int:
    """Remove catalog entries for missing source audio and clean derivatives."""
    output_format = getattr(args, "format", "text")
    verbose = getattr(args, "verbose", False)
    execute = getattr(args, "execute", False)
    force = getattr(args, "force", False)
    prune_orphans = getattr(args, "prune_orphans", False)
    command_name = "clean"
    combine_json = prune_orphans and output_format == "json"
    clean_result: dict | None = None
    clean_status = "success"
    clean_exit_code = 0

    # Resolve paths
    try:
        csv_path = resolve_catalog_csv(
            args.csv,
            purpose="clean",
            default_symlink=get_default_catalog_symlink(),
        )
    except FileNotFoundError as e:
        msg = str(e)
        if output_format == "json":
            print_json_result(
                name=command_name,
                status="error",
                result={
                    "error": "catalog_csv_missing",
                    "path": str(args.csv or get_default_catalog_symlink()),
                    "message": msg,
                },
            )
        else:
            print(msg)
        return 1

    normalized_symlink = args.csv_normalized or get_default_normalized_symlink()
    csv_normalized_path = (
        normalized_symlink.resolve() if normalized_symlink.exists() else normalized_symlink
    )

    loudness_symlink = get_default_loudness_symlink()
    csv_loudness_path = (
        loudness_symlink.resolve() if loudness_symlink.exists() else loudness_symlink
    )

    archived_symlink = get_default_archived_symlink()
    csv_archived_path = (
        archived_symlink.resolve() if archived_symlink.exists() else archived_symlink
    )

    duplicates_symlink = get_default_duplicates_symlink()
    csv_duplicates_path = (
        duplicates_symlink.resolve() if duplicates_symlink.exists() else duplicates_symlink
    )

    transcripts_root = resolve_transcripts_root()

    # Load catalog
    try:
        columns, rows, entries = _load_catalog_entries(csv_path)
    except Exception as e:
        msg = f"Failed to load catalog: {e}"
        if output_format == "json":
            print_json_result(
                name=command_name,
                status="error",
                result={"error": "catalog_load_failed", "message": str(e)},
            )
        else:
            print(msg)
        return 1

    catalog_count = len(entries)

    # Load normalized catalog if it exists
    normalized_columns = None
    normalized_rows = None
    normalized_entries: list[tuple[str, str]] = []
    normalized_count = 0

    if csv_normalized_path.exists():
        try:
            normalized_columns, normalized_rows, normalized_entries = _load_catalog_entries(
                csv_normalized_path
            )
            normalized_count = len(normalized_entries)
        except Exception as e:
            if output_format == "text":
                print(f"Warning: Failed to load normalized catalog: {e}")

    # Load loudness catalog if it exists
    loudness_columns = None
    loudness_rows = None

    if csv_loudness_path.exists():
        try:
            loudness_columns, loudness_rows, _ = _load_catalog_entries(csv_loudness_path)
        except Exception as e:
            if output_format == "text":
                print(f"Warning: Failed to load loudness catalog: {e}")

    # Load archived catalog if it exists
    archived_columns = None
    archived_rows = None

    if csv_archived_path.exists():
        try:
            archived_columns, archived_rows, _ = _load_catalog_entries(csv_archived_path)
        except Exception as e:
            if output_format == "text":
                print(f"Warning: Failed to load archived catalog: {e}")

    # Load duplicates catalog if it exists
    duplicates_columns = None
    duplicates_rows = None

    if csv_duplicates_path.exists():
        try:
            duplicates_columns, duplicates_rows, _ = _load_catalog_entries(csv_duplicates_path)
        except Exception as e:
            if output_format == "text":
                print(f"Warning: Failed to load duplicates catalog: {e}")

    # Detect missing files
    missing_entries, potential_mount_issue, suspect_parents = detect_missing_originals(entries)

    if not missing_entries:
        if output_format == "json":
            clean_result = {
                "status": "no_missing",
                "catalog_entries": catalog_count,
                "message": "No missing source audio files found",
            }
            if not combine_json:
                print_json_result(name=command_name, status="success", result=clean_result)
        else:
            print("No missing source audio files found. Nothing to clean.")
        clean_exit_code = 0
    else:
        # Check for mount issue
        if potential_mount_issue and not force:
            if output_format == "json":
                print_json_result(
                    name=command_name,
                    status="error",
                    result={
                        "error": "potential_mount_issue",
                        "missing_count": len(missing_entries),
                        "suspect_parent_dirs": suspect_parents,
                        "message": "Use --force to proceed anyway",
                    },
                )
            else:
                print("WARNING: Potential mount issue detected!")
                print(
                    f"  {len(missing_entries)} files appear missing, but parent directories don't exist."
                )
                print("  This may indicate an unmounted network drive.")
                print("")
                print("  Suspect directories:")
                for parent in suspect_parents[:5]:
                    print(f"    - {parent}")
                if len(suspect_parents) > 5:
                    print(f"    ... and {len(suspect_parents) - 5} more")
                print("")
                print("  Use --force to proceed anyway.")
            return 1

        # Infer staging directory
        staging_dir = infer_staging_dir(normalized_entries) if normalized_entries else None

        # Build cleanup plan
        plan = build_cleanup_plan(
            missing_entries,
            catalog_csv=csv_path,
            normalized_csv=csv_normalized_path if csv_normalized_path.exists() else None,
            staging_dir=staging_dir,
            transcripts_root=transcripts_root,
            potential_mount_issue=potential_mount_issue,
            suspect_parent_dirs=suspect_parents,
        )

        # Dry run - just show what would be done
        if not execute:
            if output_format == "json":
                clean_result = {
                    "status": "dry_run",
                    "catalog_entries": catalog_count,
                    "normalized_entries": normalized_count,
                    "missing_count": len(plan.targets),
                    "missing_hashes": [t.sha256 for t in plan.targets],
                    "staged_to_remove": plan.total_staged,
                    "transcript_dirs_to_remove": plan.total_transcript_dirs,
                    "diarization_dirs_to_remove": plan.total_diarization_dirs,
                    "sidecar_files_to_remove": plan.total_sidecar_files,
                    "potential_mount_issue": plan.potential_mount_issue,
                    "suspect_parent_dirs": plan.suspect_parent_dirs,
                }
                if not combine_json:
                    print_json_result(name=command_name, status="success", result=clean_result)
            else:
                print(_format_dry_run_report(plan, catalog_count, normalized_count, verbose))
            clean_exit_code = 0
        else:
            # Execute cleanup
            hash_column = resolve_hash_column(columns, csv_path, preferred="Hash")
            result = execute_cleanup(plan)
            remove_hashes = set(getattr(result, "succeeded_hashes", []))

            # Only rewrite catalogs for successfully cleaned entries
            if remove_hashes:
                # Filter and rewrite catalog
                kept_rows, _ = filter_catalog_rows(
                    rows, remove_hashes=remove_hashes, hash_column=hash_column
                )
                write_merged_csv(csv_path, kept_rows, columns=columns, encoding="utf-8")
                new_catalog_count = len(kept_rows)

                # Filter and rewrite normalized catalog if it exists
                if normalized_rows is not None and normalized_columns is not None:
                    norm_hash_column = resolve_hash_column(
                        normalized_columns, csv_normalized_path, preferred="Hash"
                    )
                    kept_norm_rows, _ = filter_catalog_rows(
                        normalized_rows, remove_hashes=remove_hashes, hash_column=norm_hash_column
                    )
                    write_merged_csv(
                        csv_normalized_path,
                        kept_norm_rows,
                        columns=normalized_columns,
                        encoding="utf-8",
                    )

                # Filter and rewrite loudness catalog if it exists
                if loudness_rows is not None and loudness_columns is not None:
                    loudness_hash_column = resolve_hash_column(
                        loudness_columns, csv_loudness_path, preferred="Hash"
                    )
                    kept_loudness_rows, _ = filter_catalog_rows(
                        loudness_rows, remove_hashes=remove_hashes, hash_column=loudness_hash_column
                    )
                    write_merged_csv(
                        csv_loudness_path,
                        kept_loudness_rows,
                        columns=loudness_columns,
                        encoding="utf-8",
                    )

                # Filter and rewrite archived catalog if it exists
                if archived_rows is not None and archived_columns is not None:
                    archived_hash_column = resolve_hash_column(
                        archived_columns, csv_archived_path, preferred="Hash"
                    )
                    kept_archived_rows, _ = filter_catalog_rows(
                        archived_rows, remove_hashes=remove_hashes, hash_column=archived_hash_column
                    )
                    write_merged_csv(
                        csv_archived_path,
                        kept_archived_rows,
                        columns=archived_columns,
                        encoding="utf-8",
                    )

                # Filter and rewrite duplicates catalog if it exists
                if duplicates_rows is not None and duplicates_columns is not None:
                    duplicates_hash_column = resolve_hash_column(
                        duplicates_columns, csv_duplicates_path, preferred="Hash"
                    )
                    kept_duplicates_rows, _ = filter_catalog_rows(
                        duplicates_rows,
                        remove_hashes=remove_hashes,
                        hash_column=duplicates_hash_column,
                    )
                    write_merged_csv(
                        csv_duplicates_path,
                        kept_duplicates_rows,
                        columns=duplicates_columns,
                        encoding="utf-8",
                    )
            else:
                # Nothing removed - keep catalogs unchanged
                new_catalog_count = catalog_count

            if output_format == "json":
                clean_status = "success" if not result.errors else "error"
                clean_result = {
                    "status": "success",
                    "catalog_entries_before": catalog_count,
                    "catalog_entries_after": new_catalog_count,
                    "hashes_removed": result.hashes_removed,
                    "hashes_failed": getattr(result, "hashes_failed", 0),
                    "failed_hashes": getattr(result, "failed_hashes", []),
                    "staged_removed": result.staged_removed,
                    "transcript_dirs_removed": result.transcript_dirs_removed,
                    "diarization_dirs_removed": result.diarization_dirs_removed,
                    "sidecar_files_removed": result.sidecar_files_removed,
                    "errors": result.errors,
                }
                if not combine_json:
                    print_json_result(name=command_name, status=clean_status, result=clean_result)
            else:
                print(
                    _format_execution_report(
                        plan,
                        result,
                        catalog_count,
                        new_catalog_count,
                    )
                )

            clean_exit_code = 1 if result.errors else 0

    if prune_orphans:
        if combine_json:
            prune_exit_code, _, prune_result = _handle_prune_orphans(args, emit_output=False)
            overall_status = "success" if clean_exit_code == 0 and prune_exit_code == 0 else "error"
            print_json_result(
                name=command_name,
                status=overall_status,
                result={"clean": clean_result, "prune_orphans": prune_result},
            )
            return 1 if overall_status == "error" else 0

        prune_exit_code, _, _ = _handle_prune_orphans(args, emit_output=True)
        return 1 if clean_exit_code or prune_exit_code else 0

    return clean_exit_code
