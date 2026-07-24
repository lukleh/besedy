"""Compatibility imports for artifact symlink helpers.

New library code should import :mod:`besedy.core.symlinks` directly. Catalog
commands may keep using this historical module path.
"""

from __future__ import annotations

from besedy.core.symlinks import (
    _ensure_chain_alignment,
    create_or_update_symlink,
    validate_symlink_can_be_created,
)

__all__ = [
    "_ensure_chain_alignment",
    "create_or_update_symlink",
    "validate_symlink_can_be_created",
]
