"""Catalog cleanup command - remove entries for missing source files and their derivatives."""

from __future__ import annotations

import argparse
from contextlib import AbstractContextManager, nullcontext
from pathlib import Path

from besedy.commands.catalog.csv_utils import resolve_catalog_csv
from besedy.commands.catalog.default_paths import get_default_catalog_symlink
from besedy.core.cli_output import print_json_result
from besedy.core.paths import (
    extract_timestamp_from_normalized_catalog,
    resolve_transcripts_parent,
)
from besedy.lib.catalog.cleaner import (
    CleanupPlan,
    build_cleanup_plan,
    detect_missing_originals,
    execute_cleanup,
    infer_staging_dir,
)
from besedy.lib.catalog.manager import load_csv, resolve_hash_column
from besedy.lib.catalog.remover import (
    CatalogGeneration,
    CatalogTimestampError,
    catalog_generation,
    find_other_catalog_references_for,
    remove_hashes_from_csv,
    shared_derived_paths,
)
from besedy.lib.data.atomic_io import exclusive_lock


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


def _resolve_generation(
    csv_arg: Path | None, *, purpose: str
) -> tuple[CatalogGeneration | None, dict | None]:
    """Resolve ``--csv`` to the catalog generation every path is derived from.

    Returns ``(generation, None)`` or ``(None, error_result)``.
    """
    try:
        csv_path = resolve_catalog_csv(
            csv_arg, purpose=purpose, default_symlink=get_default_catalog_symlink()
        )
    except FileNotFoundError as e:
        return None, {
            "error": "catalog_csv_missing",
            "path": str(csv_arg or get_default_catalog_symlink()),
            "message": str(e),
        }
    try:
        generation = catalog_generation(csv_path, transcripts_parent=resolve_transcripts_parent())
    except CatalogTimestampError as e:
        return None, {
            "error": "catalog_timestamp_missing",
            "path": str(csv_path),
            "message": str(e),
        }
    return generation, None


def _resolve_normalized_csv(
    csv_arg: Path | None, generation: CatalogGeneration
) -> tuple[Path | None, dict | None]:
    """Return the catalog's staged manifest, if any, or an error for another catalog's.

    Returns ``(path_or_none, None)`` or ``(None, error_result)``.
    """
    if csv_arg is not None and csv_arg.expanduser().exists():
        resolved = csv_arg.expanduser().resolve()
        if extract_timestamp_from_normalized_catalog(resolved) != generation.timestamp:
            return None, {
                "error": "catalog_mismatch",
                "path": str(resolved),
                "message": (
                    f"--csv-normalized {resolved} is not the staged manifest of "
                    f"{generation.catalog_csv.name}"
                ),
            }
        return resolved, None
    candidates = (
        generation.derived_csv("_loudness_normalized"),
        generation.derived_csv("_normalized"),
    )
    return next((path for path in candidates if path.is_file()), None), None


def _emit_error(output_format: str, result: dict) -> None:
    if output_format == "json":
        print_json_result(name="clean", status="error", result=result)
    else:
        print(result["message"])


def _ingest_lock(generation: CatalogGeneration, execute: bool) -> AbstractContextManager[object]:
    """The catalog's ingest lock when deleting, so no upload changes it meanwhile.

    Uploads hold it around their whole `run-pipeline`; `clean` must never run
    inside such a flow, which would wait for itself.
    """
    return exclusive_lock(generation.ingest_lock_path) if execute else nullcontext()


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
    if plan.total_shared_staged:
        lines.append(
            f"Kept: {plan.total_shared_staged} staged WAV files another catalog still lists"
        )

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
    lines.append(f"To execute: just catalog clean --csv {plan.catalog_csv} --execute")
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
    execute = getattr(args, "execute", False)

    generation, error = _resolve_generation(args.csv, purpose="clean --prune-orphans")
    if generation is None:
        assert error is not None
        if emit_output:
            _emit_error(output_format, error)
        return 1, "error", error

    # Read the catalog under the lock: an upload adds its row before writing
    # sidecars, so a stale read would delete the new recording's files.
    with _ingest_lock(generation, execute):
        return _prune_orphans(generation, args, emit_output=emit_output)


def _prune_orphans(
    generation: CatalogGeneration,
    args: argparse.Namespace,
    *,
    emit_output: bool,
) -> tuple[int, str, dict]:
    output_format = getattr(args, "format", "text")
    verbose = getattr(args, "verbose", False)
    execute = getattr(args, "execute", False)
    command_name = "clean"
    csv_path = generation.catalog_csv
    # Only this catalog's generation: sidecars of other catalogs' hashes are
    # not orphans there.
    transcripts_root = generation.transcripts_root

    # Load catalog
    try:
        _, _, entries = _load_catalog_entries(csv_path)
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
                print(f"To execute: just catalog clean --csv {csv_path} --prune-orphans --execute")
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


def _generation_csvs(generation: CatalogGeneration, normalized_csv: Path | None) -> list[Path]:
    """The catalog and every derived CSV of its generation that exists."""
    paths = [path for path in generation.csv_paths if path.is_file()]
    if normalized_csv is not None and normalized_csv not in paths:
        paths.append(normalized_csv)
    return paths


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
        help=(
            "Source catalog CSV. Default: audio_catalog.csv symlink. Its derived CSVs, "
            "staged audio and transcripts_<timestamp> are cleaned, whichever catalog "
            "the other symlinks point at."
        ),
    )
    parser.add_argument(
        "--csv-normalized",
        type=Path,
        default=None,
        help=(
            "Staged catalog (output of stage-audio) of the --csv catalog. "
            "Default: its audio_catalog_<timestamp>_loudness_normalized.csv."
        ),
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

    # Every path comes from the catalog's timestamp, never from the "latest"
    # symlinks, which may name another catalog.
    generation, error = _resolve_generation(args.csv, purpose="clean")
    if generation is None:
        assert error is not None
        _emit_error(output_format, error)
        return 1
    csv_path = generation.catalog_csv

    csv_normalized_path, error = _resolve_normalized_csv(args.csv_normalized, generation)
    if error is not None:
        _emit_error(output_format, error)
        return 1

    transcripts_root = generation.transcripts_root

    # Load catalog
    try:
        _, _, entries = _load_catalog_entries(csv_path)
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
    normalized_entries: list[tuple[str, str]] = []
    normalized_count = 0

    if csv_normalized_path is not None:
        try:
            _, _, normalized_entries = _load_catalog_entries(csv_normalized_path)
            normalized_count = len(normalized_entries)
        except Exception as e:
            if output_format == "text":
                print(f"Warning: Failed to load normalized catalog: {e}")

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

        # Staged WAVs another catalog still lists stay, like `catalog remove`.
        references = find_other_catalog_references_for(
            csv_path, [sha256 for sha256, _ in missing_entries]
        )

        def shared_files_for(sha256: str) -> set[Path]:
            key = sha256.strip().lower()
            return shared_derived_paths(references.get(key, []), key)

        # Build cleanup plan
        plan = build_cleanup_plan(
            missing_entries,
            catalog_csv=csv_path,
            normalized_csv=csv_normalized_path,
            staging_dir=staging_dir,
            transcripts_root=transcripts_root,
            potential_mount_issue=potential_mount_issue,
            suspect_parent_dirs=suspect_parents,
            shared_files_for=shared_files_for,
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
                    "shared_staged_kept": plan.total_shared_staged,
                    "potential_mount_issue": plan.potential_mount_issue,
                    "suspect_parent_dirs": plan.suspect_parent_dirs,
                }
                if not combine_json:
                    print_json_result(name=command_name, status="success", result=clean_result)
            else:
                print(_format_dry_run_report(plan, catalog_count, normalized_count, verbose))
            clean_exit_code = 0
        else:
            # Execute cleanup under the ingest lock; each CSV is re-read as it
            # is rewritten, so rows added since this run read it are kept.
            with exclusive_lock(generation.ingest_lock_path):
                result = execute_cleanup(plan)
                remove_hashes = set(getattr(result, "succeeded_hashes", []))
                new_catalog_count = catalog_count
                # Only rewrite catalogs for successfully cleaned entries
                if remove_hashes:
                    for path in _generation_csvs(generation, csv_normalized_path):
                        removed = remove_hashes_from_csv(path, remove_hashes)
                        if path == csv_path:
                            new_catalog_count = catalog_count - removed

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
