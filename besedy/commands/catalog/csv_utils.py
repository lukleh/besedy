"""CSV helpers shared by catalog commands."""

from __future__ import annotations

from pathlib import Path

from besedy.lib.workflow.common import CsvAudioRow, iter_audio_csv_rows


def resolve_catalog_csv(
    csv_path: Path | None,
    *,
    purpose: str,
    default_symlink: Path | None = None,
) -> Path:
    """Return a catalog CSV path, falling back to the project symlink."""

    if csv_path is not None:
        candidate = csv_path.expanduser()
    else:
        symlink = default_symlink
        if symlink and (symlink.exists() or symlink.is_symlink()):
            candidate = symlink.resolve()
        else:
            raise FileNotFoundError(
                f"No --csv provided for '{purpose}' and default '{symlink}' was not found."
            )
    if not candidate.is_file():
        raise FileNotFoundError(f"Catalog not found at {candidate} for '{purpose}'.")
    return candidate


def load_audio_rows(
    csv_path: Path,
    *,
    require_duration: bool,
    limit: int | None,
) -> list[CsvAudioRow]:
    """Load audio rows from a catalog CSV."""

    rows = list(iter_audio_csv_rows(csv_path, require_duration=require_duration))
    if limit is not None:
        rows = rows[:limit]
    return rows
