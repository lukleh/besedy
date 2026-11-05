"""Preview or remove old, unreferenced ColBERT bundle generations."""

from __future__ import annotations

import argparse
import sys
from dataclasses import asdict

from besedy.commands.catalog.rag_backend import resolve_pipeline_rag_backend_key
from besedy.commands.catalog.system import parse_positive_int
from besedy.core.cli_output import print_json_result
from besedy.lib.rag_colbert import resolve_default_colbert_model
from besedy.lib.rag_colbert_retention import (
    DEFAULT_KEEP_BUNDLES,
    DEFAULT_MIN_AGE_HOURS,
    prune_colbert_bundles,
)


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    parser = subparsers.add_parser(
        "rag-colbert-prune",
        formatter_class=formatter_class,
        help="Preview old ColBERT bundles eligible for explicit cleanup.",
        description=__doc__,
    )
    parser.add_argument("--group", required=True, help="Catalog ID (YYYYMMDD_HHMMSS).")
    parser.add_argument("--backend", help="Backend key; defaults to the pipeline RAG backend.")
    parser.add_argument("--model", help="ColBERT model; defaults to the configured model.")
    parser.add_argument(
        "--keep",
        type=parse_positive_int,
        default=DEFAULT_KEEP_BUNDLES,
        help="Keep at least this many newest valid generations, plus all referenced bundles.",
    )
    parser.add_argument(
        "--min-age-hours",
        type=parse_positive_int,
        default=DEFAULT_MIN_AGE_HOURS,
        help="Minimum bundle age and root-wide quiet reader grace period before deletion.",
    )
    parser.add_argument(
        "--execute", action="store_true", help="Delete eligible bundles; default: dry run."
    )
    parser.add_argument("--json", action="store_true")
    parser.set_defaults(func=handle_rag_colbert_prune)
    return parser


def handle_rag_colbert_prune(args: argparse.Namespace) -> int:
    try:
        result = prune_colbert_bundles(
            workflow_group_id=args.group,
            backend_key=args.backend or resolve_pipeline_rag_backend_key(argparse.Namespace()),
            colbert_model=args.model or resolve_default_colbert_model(),
            keep=args.keep,
            min_age_hours=args.min_age_hours,
            execute=args.execute,
        )
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print_json_result(name="rag-colbert-prune", status="success", result=asdict(result))
        return 0
    print(f"ColBERT bundle retention — {'EXECUTE' if args.execute else 'DRY RUN'}")
    for entry in result.entries:
        action = "REMOVED" if entry.removed else "KEEP" if entry.keep_reasons else "WOULD REMOVE"
        print(f"{action}: {entry.path} ({entry.size_bytes} bytes)")
        for reason in entry.keep_reasons:
            print(f"  {reason}")
    if not args.execute:
        print(
            "Pass --execute with the same scope and retention options to delete eligible bundles."
        )
    return 0
