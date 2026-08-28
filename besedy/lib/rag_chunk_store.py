"""SQLite-backed chunk store bundled with ColBERT indexes."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from besedy.lib.rag_retrieval_types import RagChunk

CHUNK_SELECT_COLUMNS = """
    chunk_id,
    audio_hash,
    chunk_ordinal,
    start_sec,
    end_sec,
    text,
    run_id,
    backend_key,
    chunk_version,
    token_count,
    source_path
"""

CHUNK_FTS_BACKFILL_KEY = "chunks_fts_backfill_version"
CHUNK_FTS_BACKFILL_VERSION = "1"


@dataclass(frozen=True)
class ChunkNeighbors:
    before: list[RagChunk]
    after: list[RagChunk]


def _chunk_select_columns(*, table_alias: str = "") -> str:
    prefix = f"{table_alias}." if table_alias else ""
    return ",\n              ".join(
        f"{prefix}{column.strip()}" for column in CHUNK_SELECT_COLUMNS.strip().split(",")
    )


def _connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def _initialize_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS chunks (
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

        CREATE UNIQUE INDEX IF NOT EXISTS chunks_audio_ordinal_uq
          ON chunks(audio_hash, chunk_ordinal);

        CREATE INDEX IF NOT EXISTS chunks_audio_hash_idx
          ON chunks(audio_hash);

        CREATE INDEX IF NOT EXISTS chunks_audio_time_idx
          ON chunks(audio_hash, start_sec, end_sec);

        CREATE TABLE IF NOT EXISTS chunk_store_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          text,
          content = 'chunks',
          content_rowid = 'rowid',
          tokenize = 'unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS chunks_fts_after_insert
        AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
        END;

        CREATE TRIGGER IF NOT EXISTS chunks_fts_after_delete
        AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text)
          VALUES ('delete', old.rowid, old.text);
        END;

        CREATE TRIGGER IF NOT EXISTS chunks_fts_after_update
        AFTER UPDATE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text)
          VALUES ('delete', old.rowid, old.text);
          INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
        END;
        """
    )
    backfill_version = connection.execute(
        "SELECT value FROM chunk_store_metadata WHERE key = ?",
        (CHUNK_FTS_BACKFILL_KEY,),
    ).fetchone()
    if backfill_version is None or str(backfill_version["value"]) != CHUNK_FTS_BACKFILL_VERSION:
        # CREATE VIRTUAL TABLE does not backfill an external-content FTS index.
        # Record completion only after rebuilding so an interrupted migration is
        # retried instead of mistaking the virtual table's presence for success.
        connection.execute("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')")
        connection.execute(
            """
            INSERT INTO chunk_store_metadata (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (CHUNK_FTS_BACKFILL_KEY, CHUNK_FTS_BACKFILL_VERSION),
        )


def ensure_chunk_store_fts(*, path: Path | str) -> Path:
    """Create and backfill the FTS5 index for a new or existing chunk store."""

    store_path = Path(path)
    with _connect(store_path) as connection:
        _initialize_schema(connection)
        connection.commit()
    return store_path


def _chunk_row(chunk: RagChunk) -> tuple[object, ...]:
    if chunk.chunk_ordinal is None:
        raise ValueError(f"Chunk store requires chunk_ordinal for chunk {chunk.chunk_id}.")
    return (
        chunk.chunk_id,
        chunk.audio_hash,
        int(chunk.chunk_ordinal),
        float(chunk.start),
        float(chunk.end),
        chunk.text,
        chunk.run_id,
        chunk.backend_key,
        chunk.chunk_version,
        int(chunk.token_count),
        chunk.source_path,
    )


def _row_to_chunk(row: sqlite3.Row) -> RagChunk:
    return RagChunk(
        chunk_id=str(row["chunk_id"]),
        chunk_version=str(row["chunk_version"]),
        run_id=str(row["run_id"]),
        backend_key=str(row["backend_key"]),
        audio_hash=str(row["audio_hash"]),
        source_path=str(row["source_path"]),
        start=float(row["start_sec"]),
        end=float(row["end_sec"]),
        token_count=int(row["token_count"]),
        text=str(row["text"]),
        chunk_ordinal=int(row["chunk_ordinal"]),
    )


def write_chunk_store(*, path: Path | str, chunks: Sequence[RagChunk]) -> Path:
    """Write the bundle-local SQLite chunk store."""

    target_path = Path(path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = target_path.with_suffix(target_path.suffix + ".tmp")
    if temporary_path.exists():
        temporary_path.unlink()

    connection = _connect(temporary_path)
    try:
        _initialize_schema(connection)
        rows = [_chunk_row(chunk) for chunk in chunks]
        if rows:
            connection.executemany(
                """
                INSERT INTO chunks (
                  chunk_id,
                  audio_hash,
                  chunk_ordinal,
                  start_sec,
                  end_sec,
                  text,
                  run_id,
                  backend_key,
                  chunk_version,
                  token_count,
                  source_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        connection.commit()
    finally:
        connection.close()

    temporary_path.replace(target_path)
    return target_path


def lookup_chunks(*, path: Path | str, chunk_ids: Sequence[str]) -> list[RagChunk]:
    """Return chunk rows for the requested IDs, preserving input order."""

    if not chunk_ids:
        return []

    store_path = Path(path)
    placeholders = ", ".join("?" for _ in chunk_ids)
    with _connect(store_path) as connection:
        rows = connection.execute(
            f"""
            SELECT {CHUNK_SELECT_COLUMNS}
            FROM chunks
            WHERE chunk_id IN ({placeholders})
            """,
            list(chunk_ids),
        ).fetchall()

    by_id = {str(row["chunk_id"]): _row_to_chunk(row) for row in rows}
    return [by_id[chunk_id] for chunk_id in chunk_ids if chunk_id in by_id]


def list_chunks(*, path: Path | str) -> list[RagChunk]:
    """Return all chunks stored in the bundle-local chunk store."""

    store_path = Path(path)
    with _connect(store_path) as connection:
        rows = connection.execute(
            f"""
            SELECT {CHUNK_SELECT_COLUMNS}
            FROM chunks
            ORDER BY audio_hash, chunk_ordinal, chunk_id
            """
        ).fetchall()

    return [_row_to_chunk(row) for row in rows]


def list_chunk_ids_by_audio_hashes(
    *,
    path: Path | str,
    audio_hashes: Sequence[str],
) -> dict[str, list[str]]:
    """Return chunk IDs grouped by audio hash for the selected hashes."""

    if not audio_hashes:
        return {}

    store_path = Path(path)
    placeholders = ", ".join("?" for _ in audio_hashes)
    with _connect(store_path) as connection:
        rows = connection.execute(
            f"""
            SELECT audio_hash, chunk_id
            FROM chunks
            WHERE audio_hash IN ({placeholders})
            ORDER BY audio_hash, chunk_ordinal, chunk_id
            """,
            list(audio_hashes),
        ).fetchall()

    grouped: dict[str, list[str]] = {audio_hash: [] for audio_hash in audio_hashes}
    for row in rows:
        grouped.setdefault(str(row["audio_hash"]), []).append(str(row["chunk_id"]))
    return grouped


def delete_chunks_for_audio_hashes(
    *,
    path: Path | str,
    audio_hashes: Sequence[str],
) -> int:
    """Delete all chunks for the selected audio hashes and return the removed row count."""

    if not audio_hashes:
        return 0

    store_path = Path(path)
    placeholders = ", ".join("?" for _ in audio_hashes)
    with _connect(store_path) as connection:
        _initialize_schema(connection)
        cursor = connection.execute(
            f"DELETE FROM chunks WHERE audio_hash IN ({placeholders})",
            list(audio_hashes),
        )
        connection.commit()
        return int(cursor.rowcount or 0)


def replace_chunks_for_audio_hash(
    *,
    path: Path | str,
    audio_hash: str,
    chunks: Sequence[RagChunk],
) -> tuple[int, int]:
    """Replace all chunks for one audio hash and return (deleted, inserted) counts."""

    store_path = Path(path)
    expected_hashes = {chunk.audio_hash for chunk in chunks}
    if expected_hashes and expected_hashes != {audio_hash}:
        raise ValueError(
            f"replace_chunks_for_audio_hash expected only {audio_hash!r}, got {sorted(expected_hashes)!r}"
        )

    rows = [_chunk_row(chunk) for chunk in chunks]
    with _connect(store_path) as connection:
        _initialize_schema(connection)
        delete_cursor = connection.execute(
            "DELETE FROM chunks WHERE audio_hash = ?",
            (audio_hash,),
        )
        inserted = 0
        if rows:
            connection.executemany(
                """
                INSERT INTO chunks (
                  chunk_id,
                  audio_hash,
                  chunk_ordinal,
                  start_sec,
                  end_sec,
                  text,
                  run_id,
                  backend_key,
                  chunk_version,
                  token_count,
                  source_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
            inserted = len(rows)
        connection.commit()
        return int(delete_cursor.rowcount or 0), inserted


def count_chunks_by_audio_hash(*, path: Path | str) -> dict[str, int]:
    """Return chunk counts grouped by audio hash."""

    store_path = Path(path)
    with _connect(store_path) as connection:
        rows = connection.execute(
            """
            SELECT audio_hash, COUNT(*) AS chunk_count
            FROM chunks
            GROUP BY audio_hash
            ORDER BY audio_hash
            """
        ).fetchall()

    return {str(row["audio_hash"]): int(row["chunk_count"]) for row in rows}


def lookup_chunk_neighbors(
    *,
    path: Path | str,
    chunk_ids: Sequence[str],
    neighbor_count: int,
) -> dict[str, ChunkNeighbors]:
    """Return before/after neighbors for each selected chunk."""

    if not chunk_ids or neighbor_count <= 0:
        return {}

    store_path = Path(path)
    placeholders = ", ".join("?" for _ in chunk_ids)
    with _connect(store_path) as connection:
        rows = connection.execute(
            f"""
            WITH anchors AS (
              SELECT chunk_id, audio_hash, chunk_ordinal
              FROM chunks
              WHERE chunk_id IN ({placeholders})
            )
            SELECT
              a.chunk_id AS anchor_chunk_id,
              CASE
                WHEN c.chunk_ordinal < a.chunk_ordinal THEN 'before'
                ELSE 'after'
              END AS direction,
              {_chunk_select_columns(table_alias="c")}
            FROM anchors a
            JOIN chunks c
              ON c.audio_hash = a.audio_hash
             AND c.chunk_ordinal BETWEEN a.chunk_ordinal - ? AND a.chunk_ordinal + ?
             AND c.chunk_ordinal <> a.chunk_ordinal
            ORDER BY a.chunk_id, c.chunk_ordinal
            """,
            [*chunk_ids, neighbor_count, neighbor_count],
        ).fetchall()

    neighbors = {chunk_id: ChunkNeighbors(before=[], after=[]) for chunk_id in chunk_ids}
    for row in rows:
        anchor_chunk_id = str(row["anchor_chunk_id"])
        direction = str(row["direction"])
        target = neighbors.setdefault(anchor_chunk_id, ChunkNeighbors(before=[], after=[]))
        chunk = _row_to_chunk(row)
        if direction == "before":
            target.before.append(chunk)
        else:
            target.after.append(chunk)
    return neighbors


__all__ = [
    "ChunkNeighbors",
    "count_chunks_by_audio_hash",
    "delete_chunks_for_audio_hashes",
    "ensure_chunk_store_fts",
    "lookup_chunk_neighbors",
    "lookup_chunks",
    "list_chunk_ids_by_audio_hashes",
    "list_chunks",
    "replace_chunks_for_audio_hash",
    "write_chunk_store",
]
