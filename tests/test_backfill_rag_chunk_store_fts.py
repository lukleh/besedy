import sqlite3
from pathlib import Path

import pytest

from besedy.lib.rag_chunk_store import ensure_chunk_store_fts
from scripts.backfill_rag_chunk_store_fts import discover_chunk_stores


def test_resolves_active_index_symlink_and_backfills_legacy_store(tmp_path: Path) -> None:
    store = tmp_path / "index_legacy" / "chunk_store.sqlite"
    store.parent.mkdir(parents=True)
    with sqlite3.connect(store) as connection:
        connection.executescript(
            """
            CREATE TABLE chunks (
              chunk_id TEXT PRIMARY KEY,
              audio_hash TEXT NOT NULL,
              chunk_ordinal INTEGER NOT NULL,
              start_sec REAL NOT NULL,
              end_sec REAL NOT NULL,
              text TEXT NOT NULL,
              run_id TEXT NOT NULL,
              backend_key TEXT NOT NULL,
              chunk_version TEXT NOT NULL,
              token_count INTEGER NOT NULL,
              source_path TEXT NOT NULL
            );
            """
        )

    active_index = tmp_path / "index"
    active_index.symlink_to(store.parent, target_is_directory=True)
    assert discover_chunk_stores([active_index]) == [store.resolve()]
    ensure_chunk_store_fts(path=store)

    with sqlite3.connect(store) as connection:
        assert connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'chunks_fts'"
        ).fetchone() == (1,)


def test_discovery_rejects_missing_roots(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="does not exist"):
        discover_chunk_stores([tmp_path / "missing"])


def test_discovery_rejects_recursive_bundle_roots(tmp_path: Path) -> None:
    nested_store = tmp_path / "index_legacy" / "chunk_store.sqlite"
    nested_store.parent.mkdir(parents=True)
    nested_store.touch()

    with pytest.raises(ValueError, match="recursive bundle-root backfills"):
        discover_chunk_stores([tmp_path])
