"""Bundle-local source state for incremental ColBERT sync."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


@dataclass(frozen=True)
class ColbertSourceStateRow:
    audio_hash: str
    transcript_path: str
    transcript_fingerprint: str
    chunking_fingerprint: str
    bundle_fingerprint: str
    chunk_count: int
    last_run_id: str
    updated_at: str | None = None


def _connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def _initialize_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS source_state (
          audio_hash TEXT PRIMARY KEY,
          transcript_path TEXT NOT NULL,
          transcript_fingerprint TEXT NOT NULL,
          chunking_fingerprint TEXT NOT NULL,
          bundle_fingerprint TEXT NOT NULL,
          chunk_count INTEGER NOT NULL,
          last_run_id TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """
    )


def _row_from_sqlite(row: sqlite3.Row) -> ColbertSourceStateRow:
    return ColbertSourceStateRow(
        audio_hash=str(row["audio_hash"]),
        transcript_path=str(row["transcript_path"]),
        transcript_fingerprint=str(row["transcript_fingerprint"]),
        chunking_fingerprint=str(row["chunking_fingerprint"]),
        bundle_fingerprint=str(row["bundle_fingerprint"]),
        chunk_count=int(row["chunk_count"]),
        last_run_id=str(row["last_run_id"]),
        updated_at=str(row["updated_at"]) if row["updated_at"] is not None else None,
    )


def initialize_source_state(path: Path | str) -> Path:
    target_path = Path(path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with _connect(target_path) as connection:
        _initialize_schema(connection)
        connection.commit()
    return target_path


def read_source_state(path: Path | str) -> dict[str, ColbertSourceStateRow]:
    source_state_path = Path(path)
    if not source_state_path.exists():
        return {}

    with _connect(source_state_path) as connection:
        _initialize_schema(connection)
        rows = connection.execute(
            """
            SELECT
              audio_hash,
              transcript_path,
              transcript_fingerprint,
              chunking_fingerprint,
              bundle_fingerprint,
              chunk_count,
              last_run_id,
              updated_at
            FROM source_state
            ORDER BY audio_hash
            """
        ).fetchall()

    return {str(row["audio_hash"]): _row_from_sqlite(row) for row in rows}


def replace_source_state(
    *,
    path: Path | str,
    rows: Sequence[ColbertSourceStateRow],
) -> Path:
    target_path = Path(path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = target_path.with_suffix(target_path.suffix + ".tmp")
    if temporary_path.exists():
        temporary_path.unlink()

    with _connect(temporary_path) as connection:
        _initialize_schema(connection)
        if rows:
            connection.executemany(
                """
                INSERT INTO source_state (
                  audio_hash,
                  transcript_path,
                  transcript_fingerprint,
                  chunking_fingerprint,
                  bundle_fingerprint,
                  chunk_count,
                  last_run_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        row.audio_hash,
                        row.transcript_path,
                        row.transcript_fingerprint,
                        row.chunking_fingerprint,
                        row.bundle_fingerprint,
                        int(row.chunk_count),
                        row.last_run_id,
                    )
                    for row in rows
                ],
            )
        connection.commit()

    temporary_path.replace(target_path)
    return target_path


def upsert_source_state_rows(
    *,
    path: Path | str,
    rows: Sequence[ColbertSourceStateRow],
) -> None:
    if not rows:
        return

    source_state_path = initialize_source_state(path)
    with _connect(source_state_path) as connection:
        _initialize_schema(connection)
        connection.executemany(
            """
            INSERT INTO source_state (
              audio_hash,
              transcript_path,
              transcript_fingerprint,
              chunking_fingerprint,
              bundle_fingerprint,
              chunk_count,
              last_run_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(audio_hash) DO UPDATE SET
              transcript_path=excluded.transcript_path,
              transcript_fingerprint=excluded.transcript_fingerprint,
              chunking_fingerprint=excluded.chunking_fingerprint,
              bundle_fingerprint=excluded.bundle_fingerprint,
              chunk_count=excluded.chunk_count,
              last_run_id=excluded.last_run_id,
              updated_at=CURRENT_TIMESTAMP
            """,
            [
                (
                    row.audio_hash,
                    row.transcript_path,
                    row.transcript_fingerprint,
                    row.chunking_fingerprint,
                    row.bundle_fingerprint,
                    int(row.chunk_count),
                    row.last_run_id,
                )
                for row in rows
            ],
        )
        connection.commit()


def delete_source_state_rows(
    *,
    path: Path | str,
    audio_hashes: Sequence[str],
) -> int:
    if not audio_hashes:
        return 0

    source_state_path = Path(path)
    if not source_state_path.exists():
        return 0

    placeholders = ", ".join("?" for _ in audio_hashes)
    with _connect(source_state_path) as connection:
        _initialize_schema(connection)
        cursor = connection.execute(
            f"DELETE FROM source_state WHERE audio_hash IN ({placeholders})",
            list(audio_hashes),
        )
        connection.commit()
        return int(cursor.rowcount or 0)


__all__ = [
    "ColbertSourceStateRow",
    "delete_source_state_rows",
    "initialize_source_state",
    "read_source_state",
    "replace_source_state",
    "upsert_source_state_rows",
]
