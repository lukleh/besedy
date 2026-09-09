"""Catalog remove command - delete one recording and all of its derived artifacts."""

from __future__ import annotations

import argparse
from pathlib import Path

from besedy.commands.catalog.csv_utils import resolve_catalog_csv
from besedy.commands.catalog.default_paths import get_default_catalog_symlink
from besedy.core.cli_output import print_json_result
from besedy.core.paths import resolve_transcripts_parent, resolve_transcripts_root
from besedy.lib.catalog.remover import (
    SPEAKER_EMBEDDINGS_DIRNAME,
    InvalidAudioHashError,
    RemovalPlan,
    RemovalResult,
    build_removal_plan,
    execute_removal,
)


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'remove' subparser."""
    parser = subparsers.add_parser(
        "remove",
        help="Remove one recording (by audio hash) and every artifact derived from it",
        description="""\
Removes a single recording from the catalog CSVs and deletes its staged WAV,
archived audio, transcripts, diarization and speaker embeddings. Duplicate and
joined manifest rows for the hash are dropped as well.

RAG chunks and speaker clusters are refreshed by the pipeline, not here: run
`catalog run-pipeline` afterwards so the ColBERT sync prunes the hash and
`cluster-speakers` rebuilds without it.

Example:
  catalog remove --hash <sha256>                     # dry run
  catalog remove --hash <sha256> --execute --delete-source
""",
        formatter_class=formatter_class,
    )
    parser.add_argument("--hash", required=True, help="Full 64-character audio hash to remove.")
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Source catalog CSV. Default: audio_catalog.csv symlink.",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually delete. Without this flag, only preview what would be removed.",
    )
    parser.add_argument(
        "--delete-source",
        action="store_true",
        help="Also delete the source audio file (and its .audiohash sidecar) listed in the catalog.",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format: text for human reading, json for scripting.",
    )
    parser.set_defaults(func=handle_remove)
    return parser


def _plan_payload(plan: RemovalPlan) -> dict[str, object]:
    return {
        "hash": plan.sha256,
        "catalog_csv": str(plan.catalog_csv),
        "csv_rows": plan.csv_rows,
        "source_files": [str(path) for path in plan.source_files],
        "staged_files": [str(path) for path in plan.staged_files],
        "archived_files": [str(path) for path in plan.archived_files],
        "transcript_dirs": [str(path) for path in plan.transcript_dirs],
        "diarization_dirs": [str(path) for path in plan.diarization_dirs],
        "embedding_dirs": [str(path) for path in plan.embedding_dirs],
    }


def _format_plan(plan: RemovalPlan, *, executed: RemovalResult | None) -> str:
    lines = [f"Recording {plan.sha256}"]
    lines.append(f"  catalog: {plan.catalog_csv}")
    for name, count in plan.csv_rows.items():
        lines.append(f"  rows in {name}: {count}")
    for label, paths in (
        ("source files", plan.source_files),
        ("staged files", plan.staged_files),
        ("archived files", plan.archived_files),
        ("transcript dirs", plan.transcript_dirs),
        ("diarization dirs", plan.diarization_dirs),
        ("embedding dirs", plan.embedding_dirs),
    ):
        lines.append(f"  {label}: {len(paths)}")
        lines.extend(f"    {path}" for path in paths)
    if executed is None:
        lines.append("Dry run - nothing removed. Re-run with --execute to delete.")
    else:
        lines.append(
            f"Removed {executed.files_removed} file(s), {executed.dirs_removed} directory(ies); "
            f"CSV rows removed: {executed.csv_rows_removed}"
        )
        lines.extend(f"  ERROR: {error}" for error in executed.errors)
    return "\n".join(lines)


def handle_remove(args: argparse.Namespace) -> int:
    """Remove one recording and its derivatives from the catalog."""
    output_format = getattr(args, "format", "text")
    execute = bool(getattr(args, "execute", False))
    delete_source = bool(getattr(args, "delete_source", False))

    def emit_error(code: str, message: str, **extra: object) -> int:
        if output_format == "json":
            print_json_result(
                name="remove",
                status="error",
                result={"error": code, "message": message, **extra},
            )
        else:
            print(f"Error: {message}")
        return 1

    try:
        csv_path = resolve_catalog_csv(
            args.csv, purpose="remove", default_symlink=get_default_catalog_symlink()
        )
    except FileNotFoundError as exc:
        return emit_error("catalog_csv_missing", str(exc))

    try:
        plan = build_removal_plan(
            args.hash,
            catalog_csv=csv_path.resolve(),
            transcripts_root=resolve_transcripts_root(),
            embedding_roots=[resolve_transcripts_parent() / SPEAKER_EMBEDDINGS_DIRNAME],
            delete_source=delete_source,
        )
    except InvalidAudioHashError as exc:
        return emit_error("invalid_hash", str(exc))

    if plan.is_empty:
        if output_format == "json":
            print_json_result(
                name="remove",
                status="success",
                result={"status": "not_found", **_plan_payload(plan)},
            )
        else:
            print(f"Nothing to remove for {plan.sha256}: no catalog rows or artifacts found.")
        return 0

    if not execute:
        if output_format == "json":
            print_json_result(
                name="remove",
                status="success",
                result={"status": "dry_run", **_plan_payload(plan)},
            )
        else:
            print(_format_plan(plan, executed=None))
        return 0

    result = execute_removal(plan)
    if output_format == "json":
        print_json_result(
            name="remove",
            status="success" if result.ok else "error",
            result={
                "status": "removed" if result.ok else "partial",
                **_plan_payload(plan),
                "files_removed": result.files_removed,
                "dirs_removed": result.dirs_removed,
                "csv_rows_removed": result.csv_rows_removed,
                "errors": result.errors,
            },
        )
    else:
        print(_format_plan(plan, executed=result))
    return 0 if result.ok else 1
