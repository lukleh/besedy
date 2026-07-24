"""Stable defaults shared across catalog commands.

This module owns the "latest" catalog symlink locations and small
cross-command constants so internal callers do not need the package facade
just to reach them.
"""

from __future__ import annotations

from pathlib import Path

from besedy.core.paths import resolve_catalogs_root

ALREADY_EXISTS_REASON = "transcripts already exist for all workflows"


def get_default_catalog_symlink() -> Path:
    """Return the default path for the audio_catalog.csv symlink."""
    return resolve_catalogs_root() / "audio_catalog.csv"


def get_default_loudness_symlink() -> Path:
    """Return the default path for the audio_catalog_loudness.csv symlink."""
    return resolve_catalogs_root() / "audio_catalog_loudness.csv"


def get_default_normalized_symlink() -> Path:
    """Return the default path for the audio_catalog_normalized.csv symlink."""
    return resolve_catalogs_root() / "audio_catalog_normalized.csv"


def get_default_duplicates_symlink() -> Path:
    """Return the default path for the audio_catalog_duplicates.csv symlink."""
    return resolve_catalogs_root() / "audio_catalog_duplicates.csv"


def get_default_archived_symlink() -> Path:
    """Return the default path for the audio_catalog_archived.csv symlink."""
    return resolve_catalogs_root() / "audio_catalog_archived.csv"


def get_default_joined_symlink() -> Path:
    """Return the default path for the audio_catalog_joined.csv symlink."""
    return resolve_catalogs_root() / "audio_catalog_joined.csv"
