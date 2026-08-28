from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from besedy.lib.rag_chunk_store import (
    count_chunks_by_audio_hash,
    delete_chunks_for_audio_hashes,
    ensure_chunk_store_fts,
    list_chunk_ids_by_audio_hashes,
    list_chunks,
    lookup_chunk_neighbors,
    lookup_chunks,
    replace_chunks_for_audio_hash,
    write_chunk_store,
)
from besedy.lib.rag_retrieval_types import RagChunk


def _chunk(*, chunk_id: str, audio_hash: str, chunk_ordinal: int | None, text: str) -> RagChunk:
    return RagChunk(
        chunk_id=chunk_id,
        chunk_version="v2",
        run_id="20260206_120000",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        audio_hash=audio_hash,
        source_path="/tmp/transcript.json",
        start=float((chunk_ordinal or 0) * 10),
        end=float((chunk_ordinal or 0) * 10 + 5),
        token_count=3,
        text=text,
        chunk_ordinal=chunk_ordinal,
    )


def test_write_and_lookup_chunk_store_preserves_requested_order(tmp_path: Path) -> None:
    store_path = tmp_path / "chunk_store.sqlite"
    write_chunk_store(
        path=store_path,
        chunks=[
            _chunk(chunk_id="chunk-0", audio_hash="a" * 64, chunk_ordinal=0, text="nula"),
            _chunk(chunk_id="chunk-1", audio_hash="a" * 64, chunk_ordinal=1, text="jedna"),
            _chunk(chunk_id="chunk-2", audio_hash="b" * 64, chunk_ordinal=0, text="dva"),
        ],
    )

    looked_up = lookup_chunks(path=store_path, chunk_ids=["chunk-2", "chunk-0", "missing"])

    assert [chunk.chunk_id for chunk in looked_up] == ["chunk-2", "chunk-0"]
    assert [chunk.text for chunk in looked_up] == ["dva", "nula"]


def _fts_matches(store_path: Path, query: str) -> list[str]:
    with sqlite3.connect(store_path) as connection:
        rows = connection.execute(
            """
            SELECT chunks.chunk_id
            FROM chunks_fts
            JOIN chunks ON chunks.rowid = chunks_fts.rowid
            WHERE chunks_fts MATCH ?
            ORDER BY chunks.chunk_id
            """,
            (query,),
        ).fetchall()
    return [str(row[0]) for row in rows]


def test_write_chunk_store_builds_accent_insensitive_fts_index(tmp_path: Path) -> None:
    store_path = tmp_path / "chunk_store.sqlite"
    write_chunk_store(
        path=store_path,
        chunks=[
            _chunk(
                chunk_id="chunk-0",
                audio_hash="a" * 64,
                chunk_ordinal=0,
                text="Příliš žluťoučký kůň",
            ),
            _chunk(
                chunk_id="chunk-1",
                audio_hash="b" * 64,
                chunk_ordinal=0,
                text="Jiný přepis",
            ),
        ],
    )

    assert _fts_matches(store_path, '"zlutoucky kun"') == ["chunk-0"]


def test_ensure_chunk_store_fts_recovers_partial_existing_backfill(tmp_path: Path) -> None:
    store_path = tmp_path / "legacy_chunk_store.sqlite"
    with sqlite3.connect(store_path) as connection:
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
            INSERT INTO chunks VALUES (
              'legacy-chunk',
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              0,
              0.0,
              5.0,
              'starší hledatelný přepis',
              '20260206_120000',
              'faster-whisper/large-v3@silero_vad_v6',
              'v2',
              3,
              '/tmp/transcript.json'
            );
            CREATE VIRTUAL TABLE chunks_fts USING fts5(
              text,
              content = 'chunks',
              content_rowid = 'rowid',
              tokenize = 'unicode61 remove_diacritics 2'
            );
            """
        )

    ensure_chunk_store_fts(path=store_path)

    assert _fts_matches(store_path, "hledatelny") == ["legacy-chunk"]


def test_lookup_chunk_neighbors_returns_before_and_after_chunks(tmp_path: Path) -> None:
    store_path = tmp_path / "chunk_store.sqlite"
    write_chunk_store(
        path=store_path,
        chunks=[
            _chunk(chunk_id="chunk-0", audio_hash="a" * 64, chunk_ordinal=0, text="prvni"),
            _chunk(chunk_id="chunk-1", audio_hash="a" * 64, chunk_ordinal=1, text="druhy"),
            _chunk(chunk_id="chunk-2", audio_hash="a" * 64, chunk_ordinal=2, text="treti"),
            _chunk(chunk_id="chunk-3", audio_hash="a" * 64, chunk_ordinal=3, text="ctvrty"),
            _chunk(chunk_id="chunk-x", audio_hash="b" * 64, chunk_ordinal=0, text="jiny"),
        ],
    )

    neighbors = lookup_chunk_neighbors(path=store_path, chunk_ids=["chunk-2"], neighbor_count=2)

    assert [chunk.chunk_id for chunk in neighbors["chunk-2"].before] == ["chunk-0", "chunk-1"]
    assert [chunk.chunk_id for chunk in neighbors["chunk-2"].after] == ["chunk-3"]


def test_write_chunk_store_requires_chunk_ordinals(tmp_path: Path) -> None:
    store_path = tmp_path / "chunk_store.sqlite"

    with pytest.raises(ValueError, match="chunk_ordinal"):
        write_chunk_store(
            path=store_path,
            chunks=[
                _chunk(
                    chunk_id="chunk-0", audio_hash="a" * 64, chunk_ordinal=None, text="bez poradi"
                )
            ],
        )


def test_replace_and_delete_chunks_for_audio_hash(tmp_path: Path) -> None:
    store_path = tmp_path / "chunk_store.sqlite"
    write_chunk_store(
        path=store_path,
        chunks=[
            _chunk(chunk_id="chunk-0", audio_hash="a" * 64, chunk_ordinal=0, text="nula"),
            _chunk(chunk_id="chunk-1", audio_hash="a" * 64, chunk_ordinal=1, text="jedna"),
            _chunk(chunk_id="chunk-x", audio_hash="b" * 64, chunk_ordinal=0, text="jiny"),
        ],
    )

    deleted, inserted = replace_chunks_for_audio_hash(
        path=store_path,
        audio_hash="a" * 64,
        chunks=[
            _chunk(chunk_id="chunk-2", audio_hash="a" * 64, chunk_ordinal=0, text="nova"),
        ],
    )

    assert (deleted, inserted) == (2, 1)
    assert [chunk.chunk_id for chunk in list_chunks(path=store_path)] == ["chunk-2", "chunk-x"]
    assert _fts_matches(store_path, "nula") == []
    assert _fts_matches(store_path, "nova") == ["chunk-2"]
    assert count_chunks_by_audio_hash(path=store_path) == {"a" * 64: 1, "b" * 64: 1}

    chunk_ids = list_chunk_ids_by_audio_hashes(path=store_path, audio_hashes=["a" * 64, "b" * 64])
    assert chunk_ids == {"a" * 64: ["chunk-2"], "b" * 64: ["chunk-x"]}

    removed = delete_chunks_for_audio_hashes(path=store_path, audio_hashes=["b" * 64])
    assert removed == 1
    assert count_chunks_by_audio_hash(path=store_path) == {"a" * 64: 1}
    assert _fts_matches(store_path, "jiny") == []
