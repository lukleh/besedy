from __future__ import annotations

import json
from pathlib import Path

from besedy.lib.rag_chunk_store import write_chunk_store
from besedy.lib.rag_colbert_runtime import worker as rag_colbert_worker
from besedy.lib.rag_pylate import (
    DEFAULT_PYLATE_PLAID_BACKEND,
    PYLATE_INDEX_FORMAT_VERSION,
    PYLATE_RETRIEVAL_ENGINE,
)
from besedy.lib.rag_retrieval_types import RagChunk


def _chunk(*, chunk_id: str, audio_hash: str, chunk_ordinal: int, text: str) -> RagChunk:
    return RagChunk(
        chunk_id=chunk_id,
        chunk_version="v2",
        run_id="20260206_120000",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        audio_hash=audio_hash,
        source_path="/tmp/transcript.json",
        start=float(chunk_ordinal * 10),
        end=float(chunk_ordinal * 10 + 5),
        token_count=3,
        text=text,
        chunk_ordinal=chunk_ordinal,
    )


def _write_bundle(tmp_path: Path) -> Path:
    bundle_dir = tmp_path / "bundle"
    (bundle_dir / "colbert_index").mkdir(parents=True)
    write_chunk_store(
        path=bundle_dir / "chunk_store.sqlite",
        chunks=[
            _chunk(chunk_id="chunk-0", audio_hash="a" * 64, chunk_ordinal=0, text="prvni"),
            _chunk(chunk_id="chunk-1", audio_hash="a" * 64, chunk_ordinal=1, text="druhy"),
            _chunk(chunk_id="chunk-2", audio_hash="a" * 64, chunk_ordinal=2, text="treti"),
            _chunk(chunk_id="chunk-x", audio_hash="b" * 64, chunk_ordinal=0, text="jiny"),
        ],
    )
    (bundle_dir / "index_meta.json").write_text(
        json.dumps(
            {
                "colbert_model": "jinaai/jina-colbert-v2",
                "doc_maxlen": 384,
                "retrieval_engine": PYLATE_RETRIEVAL_ENGINE,
                "retrieval_engine_version": "1.4.0",
                "index_format_version": PYLATE_INDEX_FORMAT_VERSION,
                "plaid_backend": DEFAULT_PYLATE_PLAID_BACKEND,
            }
        ),
        encoding="utf-8",
    )
    return bundle_dir


def test_lookup_chunks_reads_from_bundle_chunk_store(tmp_path: Path) -> None:
    bundle_dir = _write_bundle(tmp_path)

    result = rag_colbert_worker._lookup_chunks(
        {
            "colbert_index_dir": str(bundle_dir / "colbert_index"),
            "chunk_ids": ["chunk-2", "chunk-0"],
        }
    )

    assert [chunk["chunk_id"] for chunk in result["chunks"]] == ["chunk-2", "chunk-0"]
    assert result["chunks"][0]["chunk_ordinal"] == 2


def test_lookup_neighbors_reads_from_bundle_chunk_store(tmp_path: Path) -> None:
    bundle_dir = _write_bundle(tmp_path)

    result = rag_colbert_worker._lookup_neighbors(
        {
            "colbert_index_dir": str(bundle_dir / "colbert_index"),
            "chunk_ids": ["chunk-1"],
            "neighbor_count": 1,
        }
    )

    neighbors = result["neighbors"]["chunk-1"]
    assert [chunk["chunk_id"] for chunk in neighbors["before"]] == ["chunk-0"]
    assert [chunk["chunk_id"] for chunk in neighbors["after"]] == ["chunk-2"]


def test_build_index_uses_pylate_model_and_index(
    monkeypatch,
    tmp_path: Path,
) -> None:
    manifest_path = tmp_path / "manifest.jsonl"
    manifest_path.write_text(
        '{"chunk_id":"chunk-1","text":"ahoj svete","audio_hash":"'
        + ("a" * 64)
        + '","start_sec":0.0,"end_sec":1.0,"run_id":"20260206_120000","backend_key":"faster-whisper/large-v3@silero_vad_v6","chunk_version":"v2","source_path":"/tmp/transcript.json","token_count":2,"chunk_ordinal":0}\n',
        encoding="utf-8",
    )
    destination = tmp_path / "bundle" / "colbert_index"
    seen_index_calls: list[dict[str, object]] = []

    class FakeModel:
        def encode(self, texts, *, batch_size, is_query, show_progress_bar):
            assert texts == ["ahoj svete"]
            assert batch_size == 16
            assert is_query is False
            assert show_progress_bar is False
            return [["embedding"]]

    class FakeIndex:
        def add_documents(self, *, documents_ids, documents_embeddings):
            assert documents_ids == ["chunk-1"]
            assert documents_embeddings == [["embedding"]]
            destination.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(rag_colbert_worker, "_audit_tokens", lambda **_kwargs: {"chunk_count": 1})
    monkeypatch.setattr(rag_colbert_worker, "_ensure_model_snapshot", lambda _model_name: None)
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate, "resolve_pylate_device", lambda preferred=None: "cuda"
    )
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate,
        "build_pylate_model",
        lambda *, colbert_model, device, doc_maxlen: (
            colbert_model == "jinaai/jina-colbert-v2"
            and device == "cuda"
            and doc_maxlen == 384
            and FakeModel()
        ),
    )
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate,
        "open_pylate_index",
        lambda *, index_dir, plaid_backend, override, device: (
            seen_index_calls.append(
                {
                    "index_dir": str(index_dir),
                    "plaid_backend": plaid_backend,
                    "override": override,
                    "device": device,
                }
            )
            or FakeIndex()
        ),
    )
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate,
        "get_engine_metadata",
        lambda *, plaid_backend, retrieval_engine_version=None: {
            "retrieval_engine": "pylate",
            "retrieval_engine_version": "1.4.0",
            "index_format_version": "pylate-v1",
            "plaid_backend": plaid_backend,
        },
    )

    result = rag_colbert_worker._build_index(
        {
            "manifest_path": str(manifest_path),
            "colbert_index_dir": str(destination),
            "colbert_model": "jinaai/jina-colbert-v2",
            "doc_maxlen": 384,
            "index_bsize": 16,
            "plaid_backend": "fast",
        }
    )

    assert result["colbert_index_dir"] == str(destination)
    assert result["retrieval_engine"] == "pylate"
    assert result["plaid_backend"] == "fast"
    assert seen_index_calls == [
        {
            "index_dir": str(destination),
            "plaid_backend": "fast",
            "override": True,
            "device": "cuda",
        }
    ]
    assert destination.is_dir()


def test_build_index_bootstraps_and_streams_large_manifest(
    monkeypatch,
    tmp_path: Path,
) -> None:
    manifest_path = tmp_path / "manifest.jsonl"
    rows = [
        {
            "chunk_id": f"chunk-{index}",
            "text": f"text-{index}",
            "audio_hash": "a" * 64,
            "start_sec": float(index),
            "end_sec": float(index + 1),
            "run_id": "20260206_120000",
            "backend_key": "faster-whisper/large-v3@silero_vad_v6",
            "chunk_version": "v2",
            "source_path": "/tmp/transcript.json",
            "token_count": 2,
            "chunk_ordinal": index,
        }
        for index in range(5)
    ]
    manifest_path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )
    destination = tmp_path / "bundle" / "colbert_index"
    seen_encode_calls: list[list[str]] = []
    seen_add_calls: list[list[str]] = []

    class FakeModel:
        def encode(self, texts, *, batch_size, is_query, show_progress_bar):
            seen_encode_calls.append(list(texts))
            assert batch_size == 16
            assert is_query is False
            assert show_progress_bar is False
            return [[f"embedding-{text}"] for text in texts]

    class FakeIndex:
        def add_documents(self, *, documents_ids, documents_embeddings):
            seen_add_calls.append(list(documents_ids))
            assert len(documents_ids) == len(documents_embeddings)
            destination.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(rag_colbert_worker, "PYLATE_FULL_BUILD_BOOTSTRAP_DOCS", 2)
    monkeypatch.setattr(rag_colbert_worker, "PYLATE_FULL_BUILD_UPDATE_DOCS", 2)
    monkeypatch.setattr(rag_colbert_worker, "_audit_tokens", lambda **_kwargs: {"chunk_count": 5})
    monkeypatch.setattr(rag_colbert_worker, "_ensure_model_snapshot", lambda _model_name: None)
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate, "resolve_pylate_device", lambda preferred=None: "cuda"
    )
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate,
        "build_pylate_model",
        lambda *, colbert_model, device, doc_maxlen: (
            colbert_model == "jinaai/jina-colbert-v2"
            and device == "cuda"
            and doc_maxlen == 384
            and FakeModel()
        ),
    )
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate,
        "open_pylate_index",
        lambda *, index_dir, plaid_backend, override, device: (
            str(index_dir) == str(destination)
            and plaid_backend == "fast"
            and override is True
            and device == "cuda"
            and FakeIndex()
        ),
    )
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate,
        "get_engine_metadata",
        lambda *, plaid_backend, retrieval_engine_version=None: {
            "retrieval_engine": "pylate",
            "retrieval_engine_version": "1.4.0",
            "index_format_version": "pylate-v1",
            "plaid_backend": plaid_backend,
        },
    )

    result = rag_colbert_worker._build_index(
        {
            "manifest_path": str(manifest_path),
            "colbert_index_dir": str(destination),
            "colbert_model": "jinaai/jina-colbert-v2",
            "doc_maxlen": 384,
            "index_bsize": 16,
            "plaid_backend": "fast",
        }
    )

    assert result["retrieval_engine"] == "pylate"
    assert seen_encode_calls == [
        ["text-0", "text-4"],
        ["text-1", "text-2"],
        ["text-3"],
    ]
    assert seen_add_calls == [
        ["chunk-0", "chunk-4"],
        ["chunk-1", "chunk-2"],
        ["chunk-3"],
    ]


def test_add_to_index_uses_pylate_incremental_api(
    monkeypatch,
    tmp_path: Path,
) -> None:
    destination = _write_bundle(tmp_path) / "colbert_index"
    seen_index_calls: list[dict[str, object]] = []

    class FakeModel:
        def encode(self, texts, *, batch_size, is_query, show_progress_bar):
            assert texts == ["ahoj svete"]
            assert batch_size == 16
            assert is_query is False
            assert show_progress_bar is False
            return [["embedding"]]

    class FakeIndex:
        def add_documents(self, *, documents_ids, documents_embeddings):
            seen_index_calls.append(
                {
                    "documents_ids": list(documents_ids),
                    "documents_embeddings": list(documents_embeddings),
                }
            )

    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate, "resolve_pylate_device", lambda preferred=None: "cuda"
    )
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate,
        "build_pylate_model",
        lambda *, colbert_model, device, doc_maxlen: (
            colbert_model == "jinaai/jina-colbert-v2"
            and device == "cuda"
            and doc_maxlen == 384
            and FakeModel()
        ),
    )
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate,
        "open_pylate_index",
        lambda *, index_dir, plaid_backend, override, device: (
            str(index_dir) == str(destination)
            and plaid_backend == "fast"
            and override is False
            and device == "cuda"
            and FakeIndex()
        ),
    )
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate,
        "get_engine_metadata",
        lambda *, plaid_backend, retrieval_engine_version=None: {
            "retrieval_engine": "pylate",
            "retrieval_engine_version": "1.4.0",
            "index_format_version": "pylate-v1",
            "plaid_backend": plaid_backend,
        },
    )

    result = rag_colbert_worker._add_to_index(
        {
            "colbert_index_dir": str(destination),
            "rows": [
                {
                    "chunk_id": "chunk-9",
                    "text": "ahoj svete",
                    "audio_hash": "a" * 64,
                }
            ],
            "index_bsize": 16,
        }
    )

    assert result["added_chunk_ids"] == ["chunk-9"]
    assert result["retrieval_engine"] == "pylate"
    assert seen_index_calls == [
        {
            "documents_ids": ["chunk-9"],
            "documents_embeddings": [["embedding"]],
        }
    ]


def test_delete_from_index_uses_pylate_incremental_api(
    monkeypatch,
    tmp_path: Path,
) -> None:
    destination = _write_bundle(tmp_path) / "colbert_index"
    seen_chunk_ids: list[list[str]] = []

    class FakeIndex:
        def remove_documents(self, chunk_ids):
            seen_chunk_ids.append(list(chunk_ids))

    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate, "resolve_pylate_device", lambda preferred=None: "cuda"
    )
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate,
        "open_pylate_index",
        lambda *, index_dir, plaid_backend, override, device: (
            str(index_dir) == str(destination)
            and plaid_backend == "fast"
            and override is False
            and device == "cuda"
            and FakeIndex()
        ),
    )
    monkeypatch.setattr(
        rag_colbert_worker.rag_pylate,
        "get_engine_metadata",
        lambda *, plaid_backend, retrieval_engine_version=None: {
            "retrieval_engine": "pylate",
            "retrieval_engine_version": "1.4.0",
            "index_format_version": "pylate-v1",
            "plaid_backend": plaid_backend,
        },
    )

    result = rag_colbert_worker._delete_from_index(
        {
            "colbert_index_dir": str(destination),
            "chunk_ids": ["chunk-1", "chunk-2"],
        }
    )

    assert result["deleted_chunk_ids"] == ["chunk-1", "chunk-2"]
    assert result["retrieval_engine"] == "pylate"
    assert seen_chunk_ids == [["chunk-1", "chunk-2"]]
