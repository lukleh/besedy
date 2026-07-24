#!/usr/bin/env python3
"""Besedy audio catalog CLI.

Workflow and catalog management for audio transcription pipelines.
Supports creating, validating, and processing audio file catalogs.
"""

from __future__ import annotations

import argparse

from besedy.cli.parser_utils import BesedyDefaultsHelpFormatter
from besedy.commands.catalog import (
    add,
    archive,
    check,
    check_durations,
    clean,
    create,
    diarize,
    duplicates,
    extract,
    join,
    loudness,
    merge,
    pipeline,
    rag_colbert_index,
    speakers,
    stage,
    transcribe,
    validate,
)
from besedy.commands.catalog import (
    hash as hash_cmd,
)
from besedy.lib.subprocess_utils import install_signal_handlers


def build_parser() -> argparse.ArgumentParser:
    """Build the argument parser with all subcommands."""
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=BesedyDefaultsHelpFormatter,
    )

    subparsers = parser.add_subparsers(dest="command")

    # Register all subcommands from their handler modules
    create.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    merge.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    add.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    check.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    check_durations.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    clean.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    stage.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    loudness.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    validate.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    transcribe.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    diarize.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    extract.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    speakers.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    duplicates.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    archive.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    pipeline.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    join.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    hash_cmd.register_parser(subparsers, BesedyDefaultsHelpFormatter)
    rag_colbert_index.register_parser(subparsers, BesedyDefaultsHelpFormatter)

    return parser


def main(argv: list[str] | None = None) -> int:
    """Main entry point."""
    # Install signal handlers early for graceful subprocess cleanup on Ctrl+C
    install_signal_handlers()

    parser = build_parser()
    args = parser.parse_args(argv)
    handler = getattr(args, "func", None)
    if handler is None:
        parser.print_help()
        return 1
    return handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
