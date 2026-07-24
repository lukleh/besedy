"""Low-level validation and update helpers for artifact symlinks."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from besedy.core.paths_transcripts import assert_catalog_transcripts_alignment


def _ensure_chain_alignment(
    catalog_path: Path,
    normalized_path: Path,
    transcripts_root: Path,
) -> bool:
    """Validate that catalog, normalized catalog, and transcripts share a timestamp."""

    try:
        assert_catalog_transcripts_alignment(catalog_path, normalized_path, transcripts_root)
        return True
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return False


def validate_symlink_can_be_created(symlink_path: Path, *, description: str = "symlink") -> None:
    """Validate that a symlink can be created at the given path."""

    if symlink_path.is_symlink():
        return
    if symlink_path.exists():
        raise RuntimeError(
            f"Cannot create {description} symlink at {symlink_path}: "
            f"path exists as a regular file or directory. "
            f"Please remove it first or specify a different output path."
        )
    parent = symlink_path.parent
    if not parent.exists():
        raise RuntimeError(
            f"Cannot create {description} symlink at {symlink_path}: "
            f"parent directory {parent} does not exist."
        )
    if not os.access(parent, os.W_OK):
        raise RuntimeError(
            f"Cannot create {description} symlink at {symlink_path}: "
            f"parent directory {parent} is not writable."
        )


def create_or_update_symlink(
    symlink_path: Path, target_path: Path, *, description: str = "symlink"
) -> None:
    """Create or update a symlink to point to target_path."""

    if symlink_path.is_symlink():
        current_target = symlink_path.resolve()
        if current_target == target_path.resolve():
            print(
                f"Using existing {description} symlink: {symlink_path} -> {symlink_path.readlink()}"
            )
        else:
            symlink_path.unlink()
            rel_target = os.path.relpath(target_path, symlink_path.parent)
            symlink_path.symlink_to(rel_target)
            print(f"Updated {description} symlink: {symlink_path} -> {rel_target}")
    elif symlink_path.exists():
        raise RuntimeError(
            f"Cannot create {description} symlink at {symlink_path}: "
            f"path exists as a regular file or directory. "
            f"Please remove it first or specify a different output path."
        )
    else:
        rel_target = os.path.relpath(target_path, symlink_path.parent)
        symlink_path.symlink_to(rel_target)
        print(f"Created {description} symlink: {symlink_path} -> {rel_target}")


__all__ = [
    "_ensure_chain_alignment",
    "create_or_update_symlink",
    "validate_symlink_can_be_created",
]
