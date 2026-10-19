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

from besedy.commands.analyze import compare, patch_candidates, repetition, validate


def build_parser() -> argparse.ArgumentParser:
    """Assemble the focused analysis commands."""
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", help="Command to run")
    for command in (validate, compare, repetition, patch_candidates):
        command.register_parser(subparsers)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 0
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
