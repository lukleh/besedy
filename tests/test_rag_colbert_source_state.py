from __future__ import annotations

from pathlib import Path

from besedy.lib.rag_colbert_source_state import (
    ColbertSourceStateRow,
    delete_source_state_rows,
    read_source_state,
    replace_source_state,
    upsert_source_state_rows,
)


def _row(
    audio_hash: str, *, chunk_count: int = 1, transcript_path: str | None = None
) -> ColbertSourceStateRow:
    return ColbertSourceStateRow(
        audio_hash=audio_hash,
        transcript_path=transcript_path or f"/tmp/{audio_hash}.json",
        transcript_fingerprint=f"tfp-{audio_hash}",
        chunking_fingerprint="chunking-fp",
        bundle_fingerprint="bundle-fp",
        chunk_count=chunk_count,
        last_run_id="20260206_120000",
    )


def test_replace_and_read_source_state(tmp_path: Path) -> None:
    path = tmp_path / "source_state.sqlite"
    replace_source_state(
        path=path,
        rows=[_row("a" * 64), _row("b" * 64, chunk_count=2)],
    )

    rows = read_source_state(path)

    assert sorted(rows) == ["a" * 64, "b" * 64]
    assert rows["b" * 64].chunk_count == 2


def test_upsert_and_delete_source_state_rows(tmp_path: Path) -> None:
    path = tmp_path / "source_state.sqlite"
    replace_source_state(path=path, rows=[_row("a" * 64)])

    upsert_source_state_rows(
        path=path,
        rows=[
            _row("a" * 64, chunk_count=3, transcript_path="/tmp/updated.json"),
            _row("b" * 64, chunk_count=1),
        ],
    )

    rows = read_source_state(path)
    assert rows["a" * 64].chunk_count == 3
    assert rows["a" * 64].transcript_path == "/tmp/updated.json"
    assert "b" * 64 in rows

    deleted = delete_source_state_rows(path=path, audio_hashes=["a" * 64])
    assert deleted == 1
    rows = read_source_state(path)
    assert sorted(rows) == ["b" * 64]
