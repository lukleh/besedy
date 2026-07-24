"""Shared utilities for CLI argument parsers."""

from __future__ import annotations

import argparse


class BesedyDefaultsHelpFormatter(argparse.ArgumentDefaultsHelpFormatter):
    """ArgumentDefaultsHelpFormatter with better defaults for Besedy.

    Besedy computes some defaults dynamically (e.g. repo symlinks, auto parallelism),
    so showing `(default: None)` is confusing. We also avoid duplicating defaults when
    the help text already describes them.
    """

    def _get_help_string(self, action: argparse.Action) -> str | None:
        help_text = action.help or ""
        if not help_text:
            return help_text
        if action.default is None:
            return help_text
        lowered = help_text.lower()
        if "default:" in lowered or "defaults to" in lowered:
            return help_text
        return super()._get_help_string(action)
