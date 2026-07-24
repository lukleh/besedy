"""Atomic file-write helpers for crash-safe output.

Writers in besedy must never leave a half-written file at its final path:
a crash mid-write would corrupt catalog CSVs, transcript JSONs, or staged
WAVs. These helpers write to a temp file on the same filesystem, fsync it,
then atomically rename it onto the final path.

Usage:
    from besedy.lib.data.atomic_io import (
        atomic_path,
        atomic_write_json,
        atomic_write_text,
    )

    atomic_write_text(path, "content")
    atomic_write_json(path, {"key": "value"}, indent=2, ensure_ascii=False)

    # For subprocesses (e.g. ffmpeg) that need an output path:
    with atomic_path(final_wav) as tmp_wav:
        run_ffmpeg(output=tmp_wav)
    # final_wav now exists; on exception the temp file is removed.
"""

from __future__ import annotations

import contextlib
import json
import os
import stat
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

__all__ = [
    "atomic_path",
    "atomic_write_json",
    "atomic_write_text",
]

_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)

# umask captured once at import (under the import lock, before any threads),
# so new files get an umask-honoring mode without mutating process umask on
# the write path.
_DEFAULT_UMASK = os.umask(0)
os.umask(_DEFAULT_UMASK)


def _fsync_file(fd: int) -> None:
    os.fsync(fd)


def _resolve_abs(path: str | Path) -> Path:
    """Normalize a path to an absolute, expanded form."""
    return Path(os.path.abspath(Path(path).expanduser()))


def _snapshot_mode(path: Path) -> int | None:
    """Return the permission bits of an existing regular file, else None.

    Symlinks and non-regular files return None so their mode is not carried
    onto the freshly published file.
    """
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        return None
    return stat.S_IMODE(st.st_mode)


@contextlib.contextmanager
def atomic_path(
    final_path: str | Path,
    *,
    before_replace: Callable[[], None] | None = None,
    follow_symlinks: bool = True,
) -> Iterator[Path]:
    """Yield a temp file that replaces final_path on success.

    The temp file is created on the same filesystem as the target so
    os.replace() is atomic. On exception the temp file is removed and the
    existing file (if any) is untouched. The published content is fsynced by
    name after the context body, so durability holds whether the caller wrote
    in place or a subprocess recreated the file at the yielded path.

    When replacing an existing file, only its permission mode is carried over;
    ownership (uid/gid) is not preserved. This is a single-operator CLI, so a
    republished file is always owned by the writing process.

    Args:
        final_path: Destination path.
        before_replace: Optional callback run immediately before rename.
        follow_symlinks: If True (default), resolve a symlink target before
            writing. If False, refuse to write through a symlink.
    """
    target = _resolve_abs(final_path)

    if target.is_symlink():
        if follow_symlinks:
            target = target.resolve(strict=False)
        else:
            raise OSError(f"Refusing atomic publication through symlink: {final_path}")

    parent = target.parent
    parent.mkdir(parents=True, exist_ok=True)

    existing_mode = _snapshot_mode(target)

    # Preserve the target's suffix so subprocesses (ffmpeg) can detect format
    # from the temp file's extension.
    suffix = target.suffix or ".tmp"

    fd, tmp_name = tempfile.mkstemp(dir=str(parent), prefix=".besedy-tmp-", suffix=suffix)
    tmp_path = Path(tmp_name)
    # Callers write via the yielded path (a second handle, or a subprocess),
    # never through this fd, so close it immediately.
    os.close(fd)
    try:
        yield tmp_path

        # Durably flush the published content by name. This covers both an
        # in-place write and a subprocess that unlinked+recreated tmp_path.
        sync_fd = os.open(str(tmp_path), os.O_RDONLY | _O_NOFOLLOW)
        try:
            _fsync_file(sync_fd)
        finally:
            os.close(sync_fd)

        # Existing files keep their mode; new files honor the umask (mkstemp
        # would otherwise publish an owner-only 0o600 file).
        if existing_mode is not None:
            os.chmod(tmp_path, existing_mode)
        else:
            os.chmod(tmp_path, 0o666 & ~_DEFAULT_UMASK)

        if before_replace is not None:
            before_replace()

        os.replace(tmp_path, target)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp_path.unlink()
        raise

    # Best-effort durability of the rename itself. The content is already
    # fsynced and the file is published, so a failure to fsync the directory
    # entry must not turn a successful publication into a raised error.
    with contextlib.suppress(OSError):
        parent_fd = os.open(str(parent), os.O_RDONLY | _O_DIRECTORY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)


def atomic_write_text(
    path: str | Path,
    text: str,
    encoding: str = "utf-8",
    *,
    before_replace: Callable[[], None] | None = None,
    follow_symlinks: bool = True,
) -> None:
    """Write text to path atomically."""
    with atomic_path(
        path,
        before_replace=before_replace,
        follow_symlinks=follow_symlinks,
    ) as tmp_path:
        with tmp_path.open("w", encoding=encoding) as handle:
            handle.write(text)


def atomic_write_json(
    path: str | Path,
    obj: Any,
    *,
    before_replace: Callable[[], None] | None = None,
    follow_symlinks: bool = True,
    **json_kwargs: Any,
) -> None:
    """Serialize obj as JSON and write it to path atomically."""
    atomic_write_text(
        path,
        json.dumps(obj, **json_kwargs),
        encoding="utf-8",
        before_replace=before_replace,
        follow_symlinks=follow_symlinks,
    )
