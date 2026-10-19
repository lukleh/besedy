"""Shared parser options and output dispatch for analysis commands."""

from __future__ import annotations

import argparse
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

from besedy.core.cli_output import print_json_result


def register_analysis_parser(
    subparsers: argparse._SubParsersAction,
    name: str,
    *,
    help: str,
    handler: Callable[..., int | dict[str, Any]],
    extra_fields: tuple[str, ...] = (),
    backend_help: str = "Filter to backend(s) (can repeat)",
) -> argparse.ArgumentParser:
    parser = subparsers.add_parser(name, help=help)
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        dest="transcripts_root",
        help="Transcripts root (default: configured transcripts location)",
    )
    parser.add_argument("--backend", action="append", dest="backend_filter", help=backend_help)
    parser.add_argument(
        "--hash",
        action="append",
        dest="hash_filter",
        help="Filter by audio hash prefix (can repeat)",
    )
    parser.add_argument("--limit", type=int, help="Limit loaded transcript files")
    parser.add_argument("--format", choices=["text", "json"], default="text")

    def dispatch(args: argparse.Namespace) -> int:
        as_json = args.format == "json"
        result = handler(
            transcripts_root=args.transcripts_root,
            backend_filter=args.backend_filter,
            hash_filter=args.hash_filter,
            limit=args.limit,
            output_format=args.format,
            return_data=as_json,
            **{field: getattr(args, field) for field in extra_fields},
        )
        if as_json:
            print_json_result(name=name, status="success", result=result)
            return 0
        return cast(int, result)

    parser.set_defaults(func=dispatch)
    return parser
