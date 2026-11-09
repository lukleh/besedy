"""Lightweight system helpers for CLI commands."""

from __future__ import annotations

import argparse

__all__ = ["parse_positive_int"]


def parse_positive_int(value: str) -> int:
    """Parse a positive integer from a string (for argparse)."""

    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"Expected positive integer, got '{value}'.") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError(f"Expected positive integer, got '{value}'.")
    return parsed
