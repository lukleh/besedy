#!/usr/bin/env python3
"""Transcript analysis CLI (JSON-first basic checks).

Focused commands:
- validate: Basic transcript integrity checks (duration/timing/content)
- compare: Cross-model comparison for the same audio hash
- repetition: Repetition severity checks
- patch-candidates: Candidate replacement spans for repetitive regions
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, cast

from besedy.commands.analyze import (
    cmd_compare,
    cmd_patch_candidates,
    cmd_repetition,
    cmd_validate,
)
from besedy.core.cli_output import print_json_result


def build_parser() -> argparse.ArgumentParser:
    """Build analyze parser with focused subcommands."""

    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # validate
    validate_parser = subparsers.add_parser(
        "validate",
        help="Basic transcript validation checks (JSON source files)",
    )
    validate_parser.add_argument(
        "--root",
        type=Path,
        default=None,
        dest="transcripts_root",
        help="Transcripts root (default: configured transcripts location)",
    )
    validate_parser.add_argument(
        "--backend",
        action="append",
        dest="backend_filter",
        help="Filter to backend(s), e.g. faster-whisper (can repeat)",
    )
    validate_parser.add_argument(
        "--hash",
        action="append",
        dest="hash_filter",
        help="Filter by audio hash prefix (can repeat)",
    )
    validate_parser.add_argument("--limit", type=int, help="Limit loaded transcript files")
    validate_parser.add_argument("--format", choices=["text", "json"], default="text")

    # compare
    compare_parser = subparsers.add_parser(
        "compare",
        help="Cross-model comparison on shared audio hashes",
    )
    compare_parser.add_argument(
        "--root",
        type=Path,
        default=None,
        dest="transcripts_root",
        help="Transcripts root (default: configured transcripts location)",
    )
    compare_parser.add_argument(
        "--backend",
        action="append",
        dest="backend_filter",
        help="Filter to backend(s) (can repeat)",
    )
    compare_parser.add_argument(
        "--hash",
        action="append",
        dest="hash_filter",
        help="Filter by audio hash prefix (can repeat)",
    )
    compare_parser.add_argument("--limit", type=int, help="Limit loaded transcript files")
    compare_parser.add_argument(
        "--min-models",
        type=int,
        default=2,
        help="Minimum models required per audio hash (default: 2)",
    )
    compare_parser.add_argument("--format", choices=["text", "json"], default="text")

    # repetition
    repetition_parser = subparsers.add_parser(
        "repetition",
        help="Measure repetition severity in transcript text",
    )
    repetition_parser.add_argument(
        "--root",
        type=Path,
        default=None,
        dest="transcripts_root",
        help="Transcripts root (default: configured transcripts location)",
    )
    repetition_parser.add_argument(
        "--backend",
        action="append",
        dest="backend_filter",
        help="Filter to backend(s) (can repeat)",
    )
    repetition_parser.add_argument(
        "--hash",
        action="append",
        dest="hash_filter",
        help="Filter by audio hash prefix (can repeat)",
    )
    repetition_parser.add_argument("--limit", type=int, help="Limit loaded transcript files")
    repetition_parser.add_argument(
        "--min-repeats",
        type=int,
        default=2,
        help="Minimum repeats for a finding (default: 2)",
    )
    repetition_parser.add_argument(
        "--include-char-repeats",
        action="store_true",
        help="Enable character-level repeat detection (slower on large transcripts)",
    )
    repetition_parser.add_argument("--format", choices=["text", "json"], default="text")

    # patch-candidates
    patch_parser = subparsers.add_parser(
        "patch-candidates",
        help="Suggest replacement text spans for repetitive regions",
    )
    patch_parser.add_argument(
        "--root",
        type=Path,
        default=None,
        dest="transcripts_root",
        help="Transcripts root (default: configured transcripts location)",
    )
    patch_parser.add_argument(
        "--backend",
        action="append",
        dest="backend_filter",
        help="Filter to backend(s) (can repeat)",
    )
    patch_parser.add_argument(
        "--hash",
        action="append",
        dest="hash_filter",
        help="Filter by audio hash prefix (can repeat)",
    )
    patch_parser.add_argument("--limit", type=int, help="Limit loaded transcript files")
    patch_parser.add_argument(
        "--min-models",
        type=int,
        default=2,
        help="Minimum models required per audio hash (default: 2)",
    )
    patch_parser.add_argument(
        "--min-repeats",
        type=int,
        default=2,
        help="Minimum repeats to consider span repetitive (default: 2)",
    )
    patch_parser.add_argument(
        "--min-overlap",
        type=float,
        default=0.5,
        help="Minimum time-overlap ratio for replacement candidates (default: 0.5)",
    )
    patch_parser.add_argument("--format", choices=["text", "json"], default="text")

    return parser


def _json_dispatch(command: str, data: Any, *, exit_code: int = 0) -> int:
    """Emit standard envelope for JSON output."""

    status = "success" if exit_code == 0 else "error"
    print_json_result(name=command, status=status, result=data)
    return exit_code


def main() -> int:
    """CLI entry point."""

    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 0

    if args.command == "validate":
        if args.format == "json":
            data = cmd_validate(
                transcripts_root=args.transcripts_root,
                backend_filter=args.backend_filter,
                hash_filter=args.hash_filter,
                limit=args.limit,
                output_format="json",
                return_data=True,
            )
            return _json_dispatch("validate", data)
        return cast(
            int,
            cmd_validate(
                transcripts_root=args.transcripts_root,
                backend_filter=args.backend_filter,
                hash_filter=args.hash_filter,
                limit=args.limit,
                output_format="text",
                return_data=False,
            ),
        )

    if args.command == "compare":
        if args.format == "json":
            data = cmd_compare(
                transcripts_root=args.transcripts_root,
                backend_filter=args.backend_filter,
                hash_filter=args.hash_filter,
                limit=args.limit,
                min_models=args.min_models,
                output_format="json",
                return_data=True,
            )
            return _json_dispatch("compare", data)
        return cast(
            int,
            cmd_compare(
                transcripts_root=args.transcripts_root,
                backend_filter=args.backend_filter,
                hash_filter=args.hash_filter,
                limit=args.limit,
                min_models=args.min_models,
                output_format="text",
                return_data=False,
            ),
        )

    if args.command == "repetition":
        if args.format == "json":
            data = cmd_repetition(
                transcripts_root=args.transcripts_root,
                backend_filter=args.backend_filter,
                hash_filter=args.hash_filter,
                limit=args.limit,
                min_repeats=args.min_repeats,
                include_char_repeats=args.include_char_repeats,
                output_format="json",
                return_data=True,
            )
            return _json_dispatch("repetition", data)
        return cast(
            int,
            cmd_repetition(
                transcripts_root=args.transcripts_root,
                backend_filter=args.backend_filter,
                hash_filter=args.hash_filter,
                limit=args.limit,
                min_repeats=args.min_repeats,
                include_char_repeats=args.include_char_repeats,
                output_format="text",
                return_data=False,
            ),
        )

    if args.command == "patch-candidates":
        if args.format == "json":
            data = cmd_patch_candidates(
                transcripts_root=args.transcripts_root,
                backend_filter=args.backend_filter,
                hash_filter=args.hash_filter,
                limit=args.limit,
                min_models=args.min_models,
                min_repeats=args.min_repeats,
                min_overlap=args.min_overlap,
                output_format="json",
                return_data=True,
            )
            return _json_dispatch("patch-candidates", data)
        return cast(
            int,
            cmd_patch_candidates(
                transcripts_root=args.transcripts_root,
                backend_filter=args.backend_filter,
                hash_filter=args.hash_filter,
                limit=args.limit,
                min_models=args.min_models,
                min_repeats=args.min_repeats,
                min_overlap=args.min_overlap,
                output_format="text",
                return_data=False,
            ),
        )

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
