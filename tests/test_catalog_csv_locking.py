"""Every writer of a catalog CSV waits for that file's rewrite lock.

`catalog add` appends, `catalog remove`/`clean` and `catalog merge --output`
replace the file; without one shared lock an append that opened the old file
lands in the unlinked copy a concurrent rewrite just replaced.
"""

from __future__ import annotations

import argparse
import csv
import fcntl
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

from besedy.commands.catalog.merge import handle_merge
from besedy.lib.catalog import remover
from besedy.lib.catalog.manager import append_csv

HASH_CONTRACT = "pcm-s16le-16000hz-mono-sha256-v1"
COLUMNS = ["Hash", "Hash Algorithm", "Full Path"]
KEEP = "a" * 64
GONE = "b" * 64
NEW = "c" * 64


def _row(value: str) -> dict[str, str]:
    return {"Hash": value, "Hash Algorithm": HASH_CONTRACT, "Full Path": f"/audio/{value[:4]}.wav"}


def _write_csv(path: Path, hashes: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(_row(value) for value in hashes)


def _read_hashes(path: Path) -> list[str]:
    with path.open(newline="", encoding="utf-8") as handle:
        return [row["Hash"] for row in csv.DictReader(handle)]


@contextmanager
def _held_rewrite_lock(path: Path) -> Iterator[None]:
    with (path.parent / f".{path.name}.lock").open("a+") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _assert_waits_for_lock(path: Path, write: Callable[[], object]) -> None:
    before = _read_hashes(path)
    with _held_rewrite_lock(path):
        worker = threading.Thread(target=write)
        worker.start()
        time.sleep(0.3)
        assert worker.is_alive()
        assert _read_hashes(path) == before
    worker.join(timeout=5)
    assert not worker.is_alive()


def test_append_waits_for_the_rewrite_lock(tmp_path: Path) -> None:
    catalog = tmp_path / "audio_catalog_20260201_120000.csv"
    _write_csv(catalog, [KEEP])

    _assert_waits_for_lock(
        catalog,
        lambda: append_csv(catalog, [_row(NEW)], columns=COLUMNS, encoding="utf-8"),
    )

    assert _read_hashes(catalog) == [KEEP, NEW]


def test_catalog_rewrite_waits_for_the_rewrite_lock(tmp_path: Path) -> None:
    catalog = tmp_path / "audio_catalog_20260201_120000.csv"
    _write_csv(catalog, [KEEP, GONE])

    _assert_waits_for_lock(catalog, lambda: remover.remove_hashes_from_csv(catalog, {GONE}))

    assert _read_hashes(catalog) == [KEEP]


def test_in_place_merge_waits_for_the_rewrite_lock(tmp_path: Path) -> None:
    target = tmp_path / "audio_catalog_20260201_120000.csv"
    source = tmp_path / "incoming.csv"
    _write_csv(target, [KEEP])
    _write_csv(source, [NEW])
    args = argparse.Namespace(
        source1=target,
        source2=source,
        output=target,
        encoding="utf-8",
        hash_column=None,
        quiet=True,
    )

    _assert_waits_for_lock(target, lambda: handle_merge(args))

    assert _read_hashes(target) == [KEEP, NEW]


def test_merge_creates_a_missing_output_directory(tmp_path: Path) -> None:
    target = tmp_path / "audio_catalog_20260201_120000.csv"
    source = tmp_path / "incoming.csv"
    output = tmp_path / "new" / "dir" / "out.csv"
    _write_csv(target, [KEEP])
    _write_csv(source, [NEW])
    args = argparse.Namespace(
        source1=target,
        source2=source,
        output=output,
        encoding="utf-8",
        hash_column=None,
        quiet=True,
    )

    assert handle_merge(args) == 0
    assert _read_hashes(output) == [KEEP, NEW]
