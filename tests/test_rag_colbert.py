from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import pytest

import besedy.lib.rag_chunk_corpus as rag_chunk_corpus
import besedy.lib.rag_colbert as rag_colbert
from besedy.commands.catalog.rag_colbert_index import (
    RagColbertIndexRequest,
    handle_rag_colbert_index,
)
from besedy.lib.rag_colbert import (
    COLBERT_DOCKER_INDEXER_TMPDIR,
    build_colbert_index,
    lookup_colbert_chunks,
    lookup_colbert_neighbors,
    query_colbert_index,
)
from besedy.lib.rag_colbert_types import ColbertIndexResult, ColbertTokenAudit


class WhitespaceTokenCounter:
    model_name = "test-whitespace"

    @staticmethod
    def count_text(text: str) -> int:
        return max(len(text.split()), 1)

    def count_texts(self, texts: list[str]) -> list[int]:
        return [self.count_text(text) for text in texts]


def _write_transcript(
    path: Path, segments: list[dict[str, object]], *, backend: str = "faster-whisper"
) -> None:
    payload = {
        "meta": {
            "backend": backend,
            "model": "large-v3",
            "audio_filepath": f"/tmp/{path.parent.name}.wav",
            "duration": max((float(seg["end"]) for seg in segments), default=0.0),
            "generation_params": {},
        },
        "segments": segments,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _write_index_meta(index_dir: Path) -> None:
    (index_dir / "colbert_index").mkdir(parents=True, exist_ok=True)
    (index_dir / "chunk_store.sqlite").write_bytes(b"sqlite")
    payload = {
        "workflow_group_id": "wg-123",
        "backend_key": "faster-whisper/large-v3@silero_vad_v6",
        "run_id": "20260206_120000",
        "chunk_version": "v2",
        "min_chunk_tokens": 220,
        "max_chunk_tokens": 300,
        "overlap_tokens": 50,
        "chunk_count": 1,
        "colbert_model": "jinaai/jina-colbert-v2",
        "doc_maxlen": 384,
        "index_bsize": 32,
        "retrieval_engine": "pylate",
        "retrieval_engine_version": "1.4.0",
        "index_format_version": "pylate-v1",
        "plaid_backend": "fast",
    }
    (index_dir / "index_meta.json").write_text(json.dumps(payload), encoding="utf-8")


def _write_manifest(index_dir: Path, *, chunk_id: str = "chunk-1") -> None:
    row = {
        "chunk_id": chunk_id,
        "audio_hash": "a" * 64,
        "start_sec": 1.0,
        "end_sec": 3.0,
        "text": "rozpocet a finance",
        "run_id": "20260206_120000",
        "backend_key": "faster-whisper/large-v3@silero_vad_v6",
        "chunk_version": "v2",
        "source_path": "/tmp/transcript.json",
        "token_count": 3,
        "chunk_ordinal": 0,
    }
    (index_dir / "chunk_manifest.jsonl").write_text(json.dumps(row) + "\n", encoding="utf-8")


def test_build_colbert_index_writes_meta_and_manifest(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    def fake_run_colbert_worker(*, command: str, payload: dict[str, object]) -> dict[str, object]:
        assert command == "build-index"
        assert payload["index_bsize"] == 32
        Path(str(payload["colbert_index_dir"])).mkdir(parents=True, exist_ok=True)
        return {
            "token_audit": {
                "tokenizer_name": "jinaai/jina-colbert-v2",
                "doc_maxlen": 384,
                "chunk_count": 1,
                "max_tokens": 3,
                "p95_tokens": 3.0,
                "overflow_count": 0,
                "overflow_fraction": 0.0,
            }
        }

    monkeypatch.setattr(rag_colbert, "_run_colbert_worker", fake_run_colbert_worker)

    transcripts_root = tmp_path / "transcripts_20260206_120000"
    backend_dir = transcripts_root / "faster-whisper" / "large-v3@silero_vad_v6"
    _write_transcript(
        backend_dir / ("a" * 64) / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "rozpocet a finance"},
            {"start": 1.0, "end": 2.0, "text": "danovy plan dnes"},
        ],
    )

    index_dir = tmp_path / "rag_colbert_index"
    result = build_colbert_index(
        workflow_group_id="wg-123",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=index_dir,
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
    )

    index_meta = json.loads((index_dir / "index_meta.json").read_text(encoding="utf-8"))
    manifest_rows = [
        json.loads(line)
        for line in (index_dir / "chunk_manifest.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    assert result.index_dir == str(index_dir)
    assert result.workflow_group_id == "wg-123"
    assert result.chunk_count == 1
    assert index_meta["workflow_group_id"] == "wg-123"
    assert index_meta["chunk_count"] == 1
    assert index_meta["min_chunk_tokens"] == 4
    assert index_meta["max_chunk_tokens"] == 8
    assert index_meta["overlap_tokens"] == 1
    assert index_meta["chunk_tokenizer_model"] == "jinaai/jina-colbert-v2"
    assert index_meta["index_bsize"] == 32
    assert index_meta["retrieval_engine"] == "pylate"
    assert index_meta["index_format_version"] == "pylate-v1"
    assert index_meta["plaid_backend"] == "fast"
    assert len(index_meta["chunking_fingerprint"]) == 64
    assert len(index_meta["bundle_fingerprint"]) == 64
    assert index_meta["chunk_distribution"]["chunk_count"] == 1
    assert len(manifest_rows) == 1
    assert len(manifest_rows[0]["chunk_id"]) == 64
    assert manifest_rows[0]["chunk_ordinal"] == 0
    assert (index_dir / "colbert_index").is_dir()
    assert (index_dir / "chunk_store.sqlite").is_file()
    assert result.chunk_tokenizer_model == "jinaai/jina-colbert-v2"
    assert result.index_bsize == 32
    assert result.retrieval_engine == "pylate"
    assert result.index_format_version == "pylate-v1"
    assert result.plaid_backend == "fast"
    assert result.chunking_fingerprint == index_meta["chunking_fingerprint"]
    assert result.bundle_fingerprint == index_meta["bundle_fingerprint"]


def test_query_colbert_index_maps_chunk_ids_from_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    index_dir = tmp_path / "colbert_query"
    index_dir.mkdir()
    _write_index_meta(index_dir)
    _write_manifest(index_dir, chunk_id="chunk-1")

    monkeypatch.setattr(
        rag_colbert,
        "_run_colbert_worker",
        lambda **_kwargs: {
            "hits": [
                {
                    "document_id": "chunk-1",
                    "score": 42.5,
                    "rank": 1,
                    "document_metadata": {"chunk_id": "chunk-1"},
                }
            ]
        },
    )

    result = query_colbert_index(query="rozpocet", index_dir=index_dir, k=5)

    assert result.workflow_group_id == "wg-123"
    assert result.colbert_model == "jinaai/jina-colbert-v2"
    assert len(result.hits) == 1
    assert result.hits[0].chunk_id == "chunk-1"
    assert result.hits[0].audio_hash == "a" * 64
    assert result.hits[0].score == 42.5
    assert result.hits[0].chunk_ordinal == 0
    assert result.min_chunk_tokens == 220
    assert result.max_chunk_tokens == 300
    assert result.overlap_tokens == 50


def test_query_colbert_index_rejects_missing_manifest(tmp_path: Path) -> None:
    index_dir = tmp_path / "colbert_query_missing_manifest"
    index_dir.mkdir()
    _write_index_meta(index_dir)

    with pytest.raises(FileNotFoundError, match="Missing ColBERT chunk manifest"):
        query_colbert_index(query="rozpocet", index_dir=index_dir, k=5)


def test_query_colbert_index_rejects_incompatible_bundle(tmp_path: Path) -> None:
    index_dir = tmp_path / "colbert_query_incompatible"
    index_dir.mkdir()
    (index_dir / "colbert_index").mkdir()
    (index_dir / "chunk_store.sqlite").write_bytes(b"sqlite")
    (index_dir / "chunk_manifest.jsonl").write_text("", encoding="utf-8")
    (index_dir / "index_meta.json").write_text(
        json.dumps({"workflow_group_id": "wg-123", "backend_key": "backend"}),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="rag-colbert-index --rebuild"):
        query_colbert_index(query="rozpocet", index_dir=index_dir, k=5)


def test_token_audit_is_recorded(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    def fake_run_colbert_worker(*, command: str, payload: dict[str, object]) -> dict[str, object]:
        assert command == "build-index"
        Path(str(payload["colbert_index_dir"])).mkdir(parents=True, exist_ok=True)
        return {
            "token_audit": {
                "tokenizer_name": "jinaai/jina-colbert-v2",
                "doc_maxlen": 384,
                "chunk_count": 1,
                "max_tokens": 512,
                "p95_tokens": 512.0,
                "overflow_count": 1,
                "overflow_fraction": 1.0,
            }
        }

    monkeypatch.setattr(rag_colbert, "_run_colbert_worker", fake_run_colbert_worker)

    transcripts_root = tmp_path / "transcripts_20260206_120002"
    backend_dir = transcripts_root / "faster-whisper" / "large-v3@silero_vad_v6"
    _write_transcript(
        backend_dir / ("b" * 64) / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "dlouhy dokument text text"},
            {"start": 1.0, "end": 2.0, "text": "vice slov pro audit"},
        ],
    )

    index_dir = tmp_path / "rag_colbert_audit"
    result = build_colbert_index(
        workflow_group_id="wg-124",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=index_dir,
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
    )

    index_meta = json.loads((index_dir / "index_meta.json").read_text(encoding="utf-8"))
    assert result.token_audit.overflow_count == 1
    assert index_meta["token_audit"]["overflow_count"] == 1
    assert index_meta["token_audit"]["max_tokens"] == 512


def test_build_colbert_index_passes_runtime_override_to_worker(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    seen_runtime_override: list[str | None] = []

    def fake_run_colbert_worker(
        *,
        command: str,
        payload: dict[str, object],
        runtime_override: str | None = None,
    ) -> dict[str, object]:
        assert command == "build-index"
        seen_runtime_override.append(runtime_override)
        Path(str(payload["colbert_index_dir"])).mkdir(parents=True, exist_ok=True)
        return {
            "token_audit": {
                "tokenizer_name": "jinaai/jina-colbert-v2",
                "doc_maxlen": 384,
                "chunk_count": 1,
                "max_tokens": 3,
                "p95_tokens": 3.0,
                "overflow_count": 0,
                "overflow_fraction": 0.0,
            }
        }

    monkeypatch.setattr(rag_colbert, "_run_colbert_worker", fake_run_colbert_worker)

    transcripts_root = tmp_path / "transcripts_20260206_120004"
    backend_dir = transcripts_root / "faster-whisper" / "large-v3@silero_vad_v6"
    _write_transcript(
        backend_dir / ("c" * 64) / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "rozpocet a finance"},
            {"start": 1.0, "end": 2.0, "text": "danovy plan dnes"},
        ],
    )

    build_colbert_index(
        workflow_group_id="wg-runtime",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=tmp_path / "rag_colbert_runtime",
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
        runtime="docker-indexer",
    )

    assert seen_runtime_override == ["docker-indexer"]


def test_build_colbert_index_uses_index_bsize_in_payload_and_bundle_fingerprint(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    seen_index_bsizes: list[int] = []

    def fake_run_colbert_worker(
        *, command: str, payload: dict[str, object], **_kwargs: object
    ) -> dict[str, object]:
        assert command == "build-index"
        seen_index_bsizes.append(int(payload["index_bsize"]))
        Path(str(payload["colbert_index_dir"])).mkdir(parents=True, exist_ok=True)
        return {
            "token_audit": {
                "tokenizer_name": "jinaai/jina-colbert-v2",
                "doc_maxlen": 384,
                "chunk_count": 1,
                "max_tokens": 3,
                "p95_tokens": 3.0,
                "overflow_count": 0,
                "overflow_fraction": 0.0,
            }
        }

    monkeypatch.setattr(rag_colbert, "_run_colbert_worker", fake_run_colbert_worker)

    transcripts_root = tmp_path / "transcripts_20260206_120004"
    backend_dir = transcripts_root / "faster-whisper" / "large-v3@silero_vad_v6"
    _write_transcript(
        backend_dir / ("c" * 64) / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "rozpocet a finance"},
            {"start": 1.0, "end": 2.0, "text": "danovy plan dnes"},
        ],
    )

    result_32 = build_colbert_index(
        workflow_group_id="wg-index-bsize",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=tmp_path / "rag_colbert_index_bsize_32",
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
        index_bsize=32,
    )
    result_16 = build_colbert_index(
        workflow_group_id="wg-index-bsize",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=tmp_path / "rag_colbert_index_bsize_16",
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
        index_bsize=16,
    )

    assert seen_index_bsizes == [32, 16]
    assert result_32.index_bsize == 32
    assert result_16.index_bsize == 16
    assert result_32.bundle_fingerprint != result_16.bundle_fingerprint


def test_build_colbert_index_accepts_chunk_tokenizer_override(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus,
        "get_chunk_token_counter",
        lambda *args, **kwargs: WhitespaceTokenCounter(),
    )

    def fake_run_colbert_worker(
        *, command: str, payload: dict[str, object], **_kwargs: object
    ) -> dict[str, object]:
        assert command == "build-index"
        Path(str(payload["colbert_index_dir"])).mkdir(parents=True, exist_ok=True)
        return {
            "token_audit": {
                "tokenizer_name": "jinaai/jina-colbert-v2",
                "doc_maxlen": 384,
                "chunk_count": 1,
                "max_tokens": 3,
                "p95_tokens": 3.0,
                "overflow_count": 0,
                "overflow_fraction": 0.0,
            }
        }

    monkeypatch.setattr(rag_colbert, "_run_colbert_worker", fake_run_colbert_worker)

    transcripts_root = tmp_path / "transcripts_20260206_120006"
    backend_dir = transcripts_root / "faster-whisper" / "large-v3@silero_vad_v6"
    _write_transcript(
        backend_dir / ("e" * 64) / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "rozpocet a finance"},
            {"start": 1.0, "end": 2.0, "text": "danovy plan dnes"},
        ],
    )

    index_dir = tmp_path / "rag_colbert_chunk_tokenizer_override"
    result = build_colbert_index(
        workflow_group_id="wg-chunk-tokenizer",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=index_dir,
        chunk_tokenizer_model="acme/custom-tokenizer",
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
    )

    index_meta = json.loads((index_dir / "index_meta.json").read_text(encoding="utf-8"))
    assert index_meta["chunk_tokenizer_model"] == "acme/custom-tokenizer"
    assert result.chunk_tokenizer_model == "acme/custom-tokenizer"


class _SyncObserved(Exception):
    pass


def _capture_sync_backend_key(
    monkeypatch: pytest.MonkeyPatch,
    request: RagColbertIndexRequest,
) -> str:
    observed: str | None = None

    def fake_sync_colbert_index(**kwargs: object) -> None:
        nonlocal observed
        observed = str(kwargs["backend_key"])
        raise _SyncObserved

    monkeypatch.setattr(
        "besedy.commands.catalog.rag_colbert_index.sync_colbert_index",
        fake_sync_colbert_index,
    )
    with pytest.raises(_SyncObserved):
        handle_rag_colbert_index(request)

    assert observed is not None
    return observed


def test_handle_rag_colbert_index_defaults_to_docker_indexer_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BESEDY_COLBERT_RUNTIME", raising=False)
    monkeypatch.setattr(
        "besedy.commands.catalog.rag_colbert_index.default_colbert_index_runtime",
        lambda: "docker-indexer",
    )

    seen_runtime_override: list[str | None] = []

    def fake_sync_colbert_index(**kwargs) -> ColbertIndexResult:
        seen_runtime_override.append(kwargs["runtime"])
        return ColbertIndexResult(
            index_dir="/tmp/rag-colbert-index",
            workflow_group_id="wg-runtime-default",
            backend_key="faster-whisper/large-v3@silero_vad_v6",
            run_id="20260206_120000",
            chunk_version="v2",
            min_chunk_tokens=220,
            max_chunk_tokens=300,
            overlap_tokens=50,
            colbert_model="jinaai/jina-colbert-v2",
            doc_maxlen=384,
            index_bsize=32,
            split_documents=False,
            use_faiss=False,
            chunk_count=1,
            token_audit=ColbertTokenAudit(
                tokenizer_name="jinaai/jina-colbert-v2",
                doc_maxlen=384,
                chunk_count=1,
                max_tokens=3,
                p95_tokens=3.0,
                overflow_count=0,
                overflow_fraction=0.0,
            ),
        )

    monkeypatch.setattr(
        "besedy.commands.catalog.rag_colbert_index.sync_colbert_index",
        fake_sync_colbert_index,
    )

    args = argparse.Namespace(
        group="wg-runtime-default",
        backend="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=None,
        index_dir=None,
        model="jinaai/jina-colbert-v2",
        chunk_tokenizer_model=None,
        doc_maxlen=384,
        index_bsize=32,
        use_faiss=False,
        runtime=None,
        force=False,
        rebuild=False,
        target_audio_hash=None,
        min_chunk_tokens=220,
        max_chunk_tokens=300,
        overlap_tokens=50,
        json=True,
    )

    assert handle_rag_colbert_index(args) == 0
    assert seen_runtime_override == ["docker-indexer"]


def test_handle_rag_colbert_index_keeps_implicit_backend_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resolved_key = "faster-whisper/large-v3@silero_vad_v6@lang-auto"

    monkeypatch.setattr(
        "besedy.commands.catalog.rag_colbert_index.resolve_pipeline_rag_backend_key",
        lambda _args: resolved_key,
    )

    request = RagColbertIndexRequest(
        group="wg-implicit-backend",
        model="test/colbert",
        runtime="docker",
    )

    assert _capture_sync_backend_key(monkeypatch, request) == resolved_key


def test_handle_rag_colbert_index_reports_unresolvable_default_backend(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """No derivable default backend means a clean error, not a traceback."""

    def raise_runtime_error(_args):
        raise RuntimeError("No faster-whisper workflow configured in besedy.toml.")

    monkeypatch.setattr(
        "besedy.commands.catalog.rag_colbert_index.resolve_pipeline_rag_backend_key",
        raise_runtime_error,
    )

    request = RagColbertIndexRequest(
        group="wg-unresolvable-backend",
        model="test/colbert",
        runtime="docker",
    )

    assert handle_rag_colbert_index(request) == 1
    stderr = capsys.readouterr().err
    assert "cannot resolve a default backend key" in stderr
    assert "Pass --backend explicitly" in stderr


def test_handle_rag_colbert_index_keeps_explicit_backend_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    explicit_key = "faster-whisper/large-v3@silero_vad_v6"

    request = RagColbertIndexRequest(
        group="wg-explicit-backend",
        backend=explicit_key,
        model="test/colbert",
        runtime="docker",
    )

    assert _capture_sync_backend_key(monkeypatch, request) == explicit_key


def test_handle_rag_colbert_index_defaults_to_docker_runtime_on_cpu_only_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BESEDY_COLBERT_RUNTIME", raising=False)
    monkeypatch.setattr(
        "besedy.commands.catalog.rag_colbert_index.default_colbert_index_runtime",
        lambda: "docker",
    )

    seen_runtime_override: list[str | None] = []

    def fake_sync_colbert_index(**kwargs) -> ColbertIndexResult:
        seen_runtime_override.append(kwargs["runtime"])
        return ColbertIndexResult(
            index_dir="/tmp/rag-colbert-index",
            workflow_group_id="wg-runtime-default-cpu",
            backend_key="faster-whisper/large-v3@silero_vad_v6",
            run_id="20260206_120000",
            chunk_version="v2",
            min_chunk_tokens=220,
            max_chunk_tokens=300,
            overlap_tokens=50,
            colbert_model="jinaai/jina-colbert-v2",
            doc_maxlen=384,
            index_bsize=32,
            split_documents=False,
            use_faiss=False,
            chunk_count=1,
            token_audit=ColbertTokenAudit(
                tokenizer_name="jinaai/jina-colbert-v2",
                doc_maxlen=384,
                chunk_count=1,
                max_tokens=3,
                p95_tokens=3.0,
                overflow_count=0,
                overflow_fraction=0.0,
            ),
        )

    monkeypatch.setattr(
        "besedy.commands.catalog.rag_colbert_index.sync_colbert_index",
        fake_sync_colbert_index,
    )

    args = argparse.Namespace(
        group="wg-runtime-default-cpu",
        backend="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=None,
        index_dir=None,
        model="jinaai/jina-colbert-v2",
        chunk_tokenizer_model=None,
        doc_maxlen=384,
        index_bsize=32,
        use_faiss=False,
        runtime=None,
        force=False,
        rebuild=False,
        target_audio_hash=None,
        min_chunk_tokens=220,
        max_chunk_tokens=300,
        overlap_tokens=50,
        json=True,
    )

    assert handle_rag_colbert_index(args) == 0
    assert seen_runtime_override == ["docker"]


def test_handle_rag_colbert_index_defers_to_runtime_env_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker")

    seen_runtime_override: list[str | None] = []

    def fake_sync_colbert_index(**kwargs) -> ColbertIndexResult:
        seen_runtime_override.append(kwargs["runtime"])
        return ColbertIndexResult(
            index_dir="/tmp/rag-colbert-index",
            workflow_group_id="wg-runtime-env",
            backend_key="faster-whisper/large-v3@silero_vad_v6",
            run_id="20260206_120000",
            chunk_version="v2",
            min_chunk_tokens=220,
            max_chunk_tokens=300,
            overlap_tokens=50,
            colbert_model="jinaai/jina-colbert-v2",
            doc_maxlen=384,
            index_bsize=32,
            split_documents=False,
            use_faiss=False,
            chunk_count=1,
            token_audit=ColbertTokenAudit(
                tokenizer_name="jinaai/jina-colbert-v2",
                doc_maxlen=384,
                chunk_count=1,
                max_tokens=3,
                p95_tokens=3.0,
                overflow_count=0,
                overflow_fraction=0.0,
            ),
        )

    monkeypatch.setattr(
        "besedy.commands.catalog.rag_colbert_index.sync_colbert_index",
        fake_sync_colbert_index,
    )

    args = argparse.Namespace(
        group="wg-runtime-env",
        backend="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=None,
        index_dir=None,
        model="jinaai/jina-colbert-v2",
        chunk_tokenizer_model=None,
        doc_maxlen=384,
        index_bsize=32,
        use_faiss=False,
        runtime=None,
        force=False,
        rebuild=False,
        target_audio_hash=None,
        min_chunk_tokens=220,
        max_chunk_tokens=300,
        overlap_tokens=50,
        json=True,
    )

    assert handle_rag_colbert_index(args) == 0
    assert seen_runtime_override == [None]


def test_handle_rag_colbert_index_defaults_to_docker_indexer_for_external_index_dir(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BESEDY_COLBERT_RUNTIME", raising=False)
    monkeypatch.setattr(
        "besedy.commands.catalog.rag_colbert_index.default_colbert_index_runtime",
        lambda: "docker-indexer",
    )

    seen_runtime_override: list[str | None] = []

    def fake_sync_colbert_index(**kwargs) -> ColbertIndexResult:
        seen_runtime_override.append(kwargs["runtime"])
        return ColbertIndexResult(
            index_dir="/tmp/rag-colbert-index",
            workflow_group_id="wg-runtime-external-index-dir",
            backend_key="faster-whisper/large-v3@silero_vad_v6",
            run_id="20260206_120000",
            chunk_version="v2",
            min_chunk_tokens=220,
            max_chunk_tokens=300,
            overlap_tokens=50,
            colbert_model="jinaai/jina-colbert-v2",
            doc_maxlen=384,
            index_bsize=32,
            split_documents=False,
            use_faiss=False,
            chunk_count=1,
            token_audit=ColbertTokenAudit(
                tokenizer_name="jinaai/jina-colbert-v2",
                doc_maxlen=384,
                chunk_count=1,
                max_tokens=3,
                p95_tokens=3.0,
                overflow_count=0,
                overflow_fraction=0.0,
            ),
        )

    monkeypatch.setattr(
        "besedy.commands.catalog.rag_colbert_index.sync_colbert_index",
        fake_sync_colbert_index,
    )

    args = argparse.Namespace(
        group="wg-runtime-external-index-dir",
        backend="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=None,
        index_dir=Path("/tmp/rag-colbert-index"),
        model="jinaai/jina-colbert-v2",
        chunk_tokenizer_model=None,
        doc_maxlen=384,
        index_bsize=32,
        use_faiss=False,
        runtime=None,
        force=False,
        rebuild=False,
        target_audio_hash=None,
        min_chunk_tokens=220,
        max_chunk_tokens=300,
        overlap_tokens=50,
        json=True,
    )

    assert handle_rag_colbert_index(args) == 0
    assert seen_runtime_override == ["docker-indexer"]


def test_run_colbert_worker_rejects_removed_isolated_runtime_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(RuntimeError, match="Unsupported ColBERT runtime override value"):
        rag_colbert._run_colbert_worker(
            command="build-index",
            payload={
                "manifest_path": "/tmp/external-colbert-bundle/chunk_manifest.jsonl",
                "colbert_index_dir": "/tmp/external-colbert-bundle/colbert_index",
                "colbert_model": "jinaai/jina-colbert-v2",
                "doc_maxlen": 384,
            },
            runtime_override="isolated",
        )


def test_build_colbert_index_emits_phase_progress(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )

    seen_live_output: list[bool] = []
    progress_messages: list[str] = []

    def fake_run_colbert_worker(
        *,
        command: str,
        payload: dict[str, object],
        runtime_override: str | None = None,
        live_output: bool = False,
        live_output_callback=None,
    ) -> dict[str, object]:
        del runtime_override
        assert command == "build-index"
        seen_live_output.append(live_output)
        assert live_output_callback is not None
        live_output_callback("Phase 4/6: auditing token lengths...")
        live_output_callback("Phase 4/6 complete in 00:00:01 | chunks=1 | overflow_chunks=0")
        live_output_callback("Phase 5/6: indexing with ColBERT...")
        live_output_callback("Phase 5/6 complete in 00:00:02")
        Path(str(payload["colbert_index_dir"])).mkdir(parents=True, exist_ok=True)
        return {
            "token_audit": {
                "tokenizer_name": "jinaai/jina-colbert-v2",
                "doc_maxlen": 384,
                "chunk_count": 1,
                "max_tokens": 3,
                "p95_tokens": 3.0,
                "overflow_count": 0,
                "overflow_fraction": 0.0,
            }
        }

    monkeypatch.setattr(rag_colbert, "_run_colbert_worker", fake_run_colbert_worker)

    transcripts_root = tmp_path / "transcripts_20260206_120005"
    backend_dir = transcripts_root / "faster-whisper" / "large-v3@silero_vad_v6"
    _write_transcript(
        backend_dir / ("d" * 64) / "transcript.json",
        [
            {"start": 0.0, "end": 1.0, "text": "rozpocet a finance"},
            {"start": 1.0, "end": 2.0, "text": "danovy plan dnes"},
        ],
    )

    build_colbert_index(
        workflow_group_id="wg-progress",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=tmp_path / "rag_colbert_progress",
        min_chunk_tokens=4,
        max_chunk_tokens=8,
        overlap_tokens=1,
        progress_callback=progress_messages.append,
    )

    assert seen_live_output == [True]
    assert progress_messages[0].startswith("Phase 1/6: building chunk corpus...")
    assert any(
        message.startswith("Phase 2/6: writing chunk manifest...") for message in progress_messages
    )
    assert any(
        message.startswith("Phase 3/6: writing chunk store...") for message in progress_messages
    )
    assert any(
        message.startswith("Phase 4/6: auditing token lengths...") for message in progress_messages
    )
    assert any(
        message.startswith("Phase 5/6: indexing with ColBERT...") for message in progress_messages
    )
    assert any(
        message.startswith("Phase 6/6: finalizing bundle metadata and pointers...")
        for message in progress_messages
    )
    assert any("Phase 6/6 complete" in message for message in progress_messages)


def test_build_colbert_index_skips_worker_for_empty_corpus(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rag_chunk_corpus, "get_chunk_token_counter", lambda: WhitespaceTokenCounter()
    )
    monkeypatch.setattr(
        rag_colbert,
        "_run_colbert_worker",
        lambda **_kwargs: pytest.fail("empty corpus should not invoke the worker"),
    )

    transcripts_root = tmp_path / "transcripts_20260206_120003"
    index_dir = tmp_path / "rag_colbert_empty"
    result = build_colbert_index(
        workflow_group_id="wg-empty",
        backend_key="faster-whisper/large-v3@silero_vad_v6",
        transcripts_root=transcripts_root,
        index_dir=index_dir,
    )

    index_meta = json.loads((index_dir / "index_meta.json").read_text(encoding="utf-8"))
    assert result.chunk_count == 0
    assert index_meta["chunk_count"] == 0
    assert not (index_dir / "colbert_index").exists()
    assert (index_dir / "chunk_store.sqlite").is_file()


def test_query_colbert_index_returns_empty_hits_for_empty_corpus(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    index_dir = tmp_path / "colbert_query_empty"
    index_dir.mkdir()
    _write_index_meta(index_dir)
    index_meta = json.loads((index_dir / "index_meta.json").read_text(encoding="utf-8"))
    index_meta["chunk_count"] = 0
    (index_dir / "index_meta.json").write_text(json.dumps(index_meta), encoding="utf-8")
    (index_dir / "chunk_manifest.jsonl").write_text("", encoding="utf-8")

    monkeypatch.setattr(
        rag_colbert,
        "_run_colbert_worker",
        lambda **_kwargs: pytest.fail("empty corpus query should not invoke the worker"),
    )

    result = query_colbert_index(query="rozpocet", index_dir=index_dir, k=5)

    assert result.hits == []
    assert result.min_chunk_tokens == 220


@pytest.mark.parametrize(
    ("command", "expected_path", "payload", "expected_response"),
    [
        (
            "query-index",
            "/query",
            {
                "colbert_index_dir": str(rag_colbert.PROJECT_ROOT / "tmp" / "colbert_index"),
                "query": "rozpocet",
                "k": 5,
            },
            {"hits": []},
        ),
        (
            "lookup-chunks",
            "/lookup",
            {
                "colbert_index_dir": str(rag_colbert.PROJECT_ROOT / "tmp" / "colbert_index"),
                "chunk_ids": ["chunk-1"],
            },
            {"chunks": []},
        ),
        (
            "lookup-neighbors",
            "/neighbors",
            {
                "colbert_index_dir": str(rag_colbert.PROJECT_ROOT / "tmp" / "colbert_index"),
                "chunk_ids": ["chunk-1"],
                "neighbor_count": 1,
            },
            {"neighbors": {}},
        ),
    ],
)
def test_run_colbert_worker_uses_docker_query_service(
    monkeypatch: pytest.MonkeyPatch,
    command: str,
    expected_path: str,
    payload: dict[str, object],
    expected_response: dict[str, object],
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker")
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    seen_commands: list[list[str]] = []
    seen_requests: list[tuple[str, str, dict[str, object] | None]] = []

    def fake_run(
        cmd: list[str],
        *,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, check
        seen_commands.append(cmd)
        assert cwd == rag_colbert.PROJECT_ROOT
        if "config" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="colbert\n", stderr="")
        if "ps" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="colbert\n", stderr="")
        pytest.fail(f"query-index should not use docker exec: {cmd}")

    def fake_http_json_request(
        *,
        method: str,
        url: str,
        payload: dict[str, object] | None = None,
        timeout: float = 30.0,
    ) -> dict[str, object]:
        del timeout
        seen_requests.append((method, url, payload))
        if method == "GET":
            return {"ready": True}
        assert payload is not None
        assert payload["colbert_index_dir"] == "/workspace/besedy/tmp/colbert_index"
        return expected_response

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)
    monkeypatch.setattr(rag_colbert, "_http_json_request", fake_http_json_request)

    result = rag_colbert._run_colbert_worker(
        command=command,
        payload=payload,
    )

    assert result == expected_response
    assert all("exec" not in command for command in seen_commands)
    assert seen_requests[0][0] == "GET"
    assert seen_requests[1][0] == "POST"
    assert seen_requests[1][1].endswith(expected_path)


def test_run_colbert_worker_uses_docker_exec_for_build_index(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker")
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    seen_commands: list[list[str]] = []

    def fake_run(
        cmd: list[str],
        *,
        input: str | None = None,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, check
        seen_commands.append(cmd)
        assert cwd == rag_colbert.PROJECT_ROOT
        if "config" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="colbert\n", stderr="")
        if "ps" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="colbert\n", stderr="")
        assert "exec" in cmd
        payload = json.loads(input or "{}")
        assert payload["manifest_path"].startswith("/workspace/besedy/tmp/")
        assert payload["colbert_index_dir"].startswith("/workspace/besedy/tmp/")
        return subprocess.CompletedProcess(
            cmd, 0, stdout='{"token_audit": {"chunk_count": 0}}', stderr=""
        )

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)

    result = rag_colbert._run_colbert_worker(
        command="build-index",
        payload={
            "manifest_path": str(rag_colbert.PROJECT_ROOT / "tmp" / "manifest.jsonl"),
            "colbert_index_dir": str(rag_colbert.PROJECT_ROOT / "tmp" / "colbert_index"),
            "colbert_model": "jinaai/jina-colbert-v2",
            "doc_maxlen": 384,
        },
    )

    assert result == {"token_audit": {"chunk_count": 0}}
    assert any("exec" in command for command in seen_commands)


def test_run_colbert_worker_uses_docker_exec_live_output_for_build_index(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker")
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    seen_commands: list[list[str]] = []
    seen_stdin_payloads: list[str] = []
    seen_progress_messages: list[str] = []

    def fake_run(
        cmd: list[str],
        *,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, check
        seen_commands.append(cmd)
        assert cwd == rag_colbert.PROJECT_ROOT
        if "config" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="colbert\n", stderr="")
        if "ps" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="colbert\n", stderr="")
        pytest.fail(f"live build-index should not use subprocess.run exec: {cmd}")

    class FakePopen:
        def __init__(
            self,
            cmd: list[str],
            *,
            stdin,
            stdout,
            stderr,
            text: bool,
            bufsize: int,
            cwd: Path,
            env=None,
        ) -> None:
            import io

            class FakeStdin:
                def __init__(self) -> None:
                    self.value = ""

                def write(self, text: str) -> int:
                    self.value += text
                    return len(text)

                def close(self) -> None:
                    return

            del stdin, stdout, text, env, bufsize
            seen_commands.append(cmd)
            assert cwd == rag_colbert.PROJECT_ROOT
            assert stderr == subprocess.PIPE
            self.pid = 12345
            self.returncode = 0
            self.stdin = FakeStdin()
            self.stdout = io.StringIO('{"token_audit": {"chunk_count": 0}}')
            self.stderr = io.StringIO(
                "Phase 4/6: auditing token lengths...\nPhase 5/6: indexing with ColBERT...\n"
            )

        def wait(self) -> int:
            seen_stdin_payloads.append(self.stdin.value)
            return self.returncode

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)
    monkeypatch.setattr(rag_colbert.subprocess, "Popen", FakePopen)

    result = rag_colbert._run_colbert_worker(
        command="build-index",
        payload={
            "manifest_path": str(rag_colbert.PROJECT_ROOT / "tmp" / "manifest.jsonl"),
            "colbert_index_dir": str(rag_colbert.PROJECT_ROOT / "tmp" / "colbert_index"),
            "colbert_model": "jinaai/jina-colbert-v2",
            "doc_maxlen": 384,
        },
        live_output=True,
        live_output_callback=seen_progress_messages.append,
    )

    assert result == {"token_audit": {"chunk_count": 0}}
    assert any("exec" in command for command in seen_commands)
    assert seen_stdin_payloads
    assert "/workspace/besedy/tmp/manifest.jsonl" in seen_stdin_payloads[0]
    assert "/workspace/besedy/tmp/colbert_index" in seen_stdin_payloads[0]
    assert seen_progress_messages == [
        "Phase 4/6: auditing token lengths...",
        "Phase 5/6: indexing with ColBERT...",
    ]


def test_run_colbert_worker_uses_docker_indexer_live_output_for_build_index_with_prefixed_stdout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker-indexer")
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    seen_commands: list[list[str]] = []
    seen_stdin_payloads: list[str] = []
    seen_progress_messages: list[str] = []

    def fake_run(
        cmd: list[str],
        *,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, check
        seen_commands.append(cmd)
        assert cwd == rag_colbert.PROJECT_ROOT
        if "config" in cmd:
            return subprocess.CompletedProcess(
                cmd, 0, stdout="colbert\ncolbert-indexer\n", stderr=""
            )
        pytest.fail(f"live docker-indexer build-index should not use subprocess.run exec: {cmd}")

    class FakePopen:
        def __init__(
            self,
            cmd: list[str],
            *,
            stdin,
            stdout,
            stderr,
            text: bool,
            bufsize: int,
            cwd: Path,
            env=None,
        ) -> None:
            import io

            class FakeStdin:
                def __init__(self) -> None:
                    self.value = ""

                def write(self, text: str) -> int:
                    self.value += text
                    return len(text)

                def close(self) -> None:
                    return

            del stdin, stdout, text, env, bufsize
            seen_commands.append(cmd)
            assert cwd == rag_colbert.PROJECT_ROOT
            assert stderr == subprocess.PIPE
            self.pid = 12347
            self.returncode = 0
            self.stdin = FakeStdin()
            self.stdout = io.StringIO(
                "==========\n== CUDA ==\n==========\n"
                '{"token_audit": {"chunk_count": 0}, "retrieval_engine_version": "1.4.0"}'
            )
            self.stderr = io.StringIO("Phase 5/6: indexing with ColBERT...\n")

        def wait(self) -> int:
            seen_stdin_payloads.append(self.stdin.value)
            return self.returncode

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)
    monkeypatch.setattr(rag_colbert.subprocess, "Popen", FakePopen)

    result = rag_colbert._run_colbert_worker(
        command="build-index",
        payload={
            "manifest_path": str(rag_colbert.PROJECT_ROOT / "tmp" / "manifest.jsonl"),
            "colbert_index_dir": str(rag_colbert.PROJECT_ROOT / "tmp" / "colbert_index"),
            "colbert_model": "jinaai/jina-colbert-v2",
            "doc_maxlen": 384,
            "index_bsize": 16,
        },
        live_output=True,
        live_output_callback=seen_progress_messages.append,
    )

    assert result == {"token_audit": {"chunk_count": 0}, "retrieval_engine_version": "1.4.0"}
    assert any("run" in command for command in seen_commands)
    assert any("--profile" in command for command in seen_commands if "run" in command)
    assert seen_stdin_payloads
    assert "/workspace/besedy/tmp/manifest.jsonl" in seen_stdin_payloads[0]
    assert "/workspace/besedy/tmp/colbert_index" in seen_stdin_payloads[0]
    assert seen_progress_messages == ["Phase 5/6: indexing with ColBERT..."]


def test_run_colbert_worker_live_output_failure_includes_stderr_detail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker")
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    def fake_run(
        cmd: list[str],
        *,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, check
        assert cwd == rag_colbert.PROJECT_ROOT
        if "config" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="colbert\n", stderr="")
        if "ps" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="colbert\n", stderr="")
        pytest.fail(f"live build-index should not use subprocess.run exec: {cmd}")

    class FakePopen:
        def __init__(
            self,
            cmd: list[str],
            *,
            stdin,
            stdout,
            stderr,
            text: bool,
            bufsize: int,
            cwd: Path,
            env=None,
        ) -> None:
            import io

            class FakeStdin:
                def write(self, text: str) -> int:
                    return len(text)

                def close(self) -> None:
                    return

            del cmd, stdin, stdout, stderr, text, bufsize, cwd, env
            self.pid = 12346
            self.returncode = 1
            self.stdin = FakeStdin()
            self.stdout = io.StringIO("")
            self.stderr = io.StringIO("backend exploded\nmore detail\n")

        def wait(self) -> int:
            return self.returncode

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)
    monkeypatch.setattr(rag_colbert.subprocess, "Popen", FakePopen)

    with pytest.raises(RuntimeError, match="backend exploded"):
        rag_colbert._run_colbert_worker(
            command="build-index",
            payload={
                "manifest_path": str(rag_colbert.PROJECT_ROOT / "tmp" / "manifest.jsonl"),
                "colbert_index_dir": str(rag_colbert.PROJECT_ROOT / "tmp" / "colbert_index"),
                "colbert_model": "jinaai/jina-colbert-v2",
                "doc_maxlen": 384,
            },
            live_output=True,
        )


def test_run_colbert_worker_requires_running_docker_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker")
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    def fake_run(
        cmd: list[str],
        *,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, cwd, check
        if "config" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="colbert\n", stderr="")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)

    with pytest.raises(
        RuntimeError,
        match="docker compose -f rag-services/docker-compose.yml up -d --build colbert",
    ):
        rag_colbert._run_colbert_worker(
            command="audit-tokens", payload={"texts": ["a"], "colbert_model": "m", "doc_maxlen": 1}
        )


def test_run_colbert_worker_uses_docker_indexer_run_for_build_index(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker-indexer")
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    seen_commands: list[list[str]] = []

    def fake_run(
        cmd: list[str],
        *,
        input: str | None = None,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, check
        seen_commands.append(cmd)
        assert cwd == rag_colbert.PROJECT_ROOT
        if "config" in cmd:
            return subprocess.CompletedProcess(
                cmd, 0, stdout="colbert\ncolbert-indexer\n", stderr=""
            )
        assert "run" in cmd
        assert "colbert-indexer" in cmd
        assert "--profile" in cmd
        assert "-T" in cmd
        env_pairs = [cmd[index + 1] for index, value in enumerate(cmd[:-1]) if value == "-e"]
        assert f"TMPDIR={COLBERT_DOCKER_INDEXER_TMPDIR}" in env_pairs
        assert f"TMP={COLBERT_DOCKER_INDEXER_TMPDIR}" in env_pairs
        assert f"TEMP={COLBERT_DOCKER_INDEXER_TMPDIR}" in env_pairs
        assert "TORCH_EXTENSIONS_DIR=/data/torch/extensions" in env_pairs
        payload = json.loads(input or "{}")
        assert payload["manifest_path"].startswith("/workspace/besedy/tmp/")
        assert payload["colbert_index_dir"].startswith("/workspace/besedy/tmp/")
        return subprocess.CompletedProcess(
            cmd, 0, stdout='{"token_audit": {"chunk_count": 0}}', stderr=""
        )

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)

    result = rag_colbert._run_colbert_worker(
        command="build-index",
        payload={
            "manifest_path": str(rag_colbert.PROJECT_ROOT / "tmp" / "manifest.jsonl"),
            "colbert_index_dir": str(rag_colbert.PROJECT_ROOT / "tmp" / "colbert_index"),
            "colbert_model": "jinaai/jina-colbert-v2",
            "doc_maxlen": 384,
            "index_bsize": 16,
        },
    )

    assert result == {"token_audit": {"chunk_count": 0}}
    assert any("run" in command for command in seen_commands)
    assert all("exec" not in command for command in seen_commands)


def test_run_colbert_worker_uses_docker_indexer_run_for_external_build_index(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker-indexer")
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    seen_commands: list[list[str]] = []

    def fake_run(
        cmd: list[str],
        *,
        input: str | None = None,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, check
        seen_commands.append(cmd)
        assert cwd == rag_colbert.PROJECT_ROOT
        if "config" in cmd:
            return subprocess.CompletedProcess(
                cmd, 0, stdout="colbert\ncolbert-indexer\n", stderr=""
            )
        assert "run" in cmd
        assert "colbert-indexer" in cmd
        volume_index = cmd.index("-v")
        assert (
            cmd[volume_index + 1]
            == "/tmp/external-colbert-bundle:/workspace/colbert-indexer-bundle:rw"
        )
        payload = json.loads(input or "{}")
        assert payload["manifest_path"] == "/workspace/colbert-indexer-bundle/chunk_manifest.jsonl"
        assert payload["colbert_index_dir"] == "/workspace/colbert-indexer-bundle/colbert_index"
        env_pairs = [cmd[index + 1] for index, value in enumerate(cmd[:-1]) if value == "-e"]
        assert "BESEDY_COLBERT_BUNDLE_DIR=/workspace/colbert-indexer-bundle" in env_pairs
        assert f"TMPDIR={COLBERT_DOCKER_INDEXER_TMPDIR}" in env_pairs
        assert "TORCH_EXTENSIONS_DIR=/data/torch/extensions" in env_pairs
        return subprocess.CompletedProcess(
            cmd, 0, stdout='{"token_audit": {"chunk_count": 0}}', stderr=""
        )

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)

    result = rag_colbert._run_colbert_worker(
        command="build-index",
        payload={
            "manifest_path": "/tmp/external-colbert-bundle/chunk_manifest.jsonl",
            "colbert_index_dir": "/tmp/external-colbert-bundle/colbert_index",
            "colbert_model": "jinaai/jina-colbert-v2",
            "doc_maxlen": 384,
            "index_bsize": 16,
        },
    )

    assert result == {"token_audit": {"chunk_count": 0}}
    assert any("run" in command for command in seen_commands)
    assert all("exec" not in command for command in seen_commands)


def test_run_colbert_worker_uses_docker_indexer_run_for_incremental_add(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker-indexer")
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    seen_commands: list[list[str]] = []

    def fake_run(
        cmd: list[str],
        *,
        input: str | None = None,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, check
        seen_commands.append(cmd)
        assert cwd == rag_colbert.PROJECT_ROOT
        if "config" in cmd:
            return subprocess.CompletedProcess(
                cmd, 0, stdout="colbert\ncolbert-indexer\n", stderr=""
            )
        assert "run" in cmd
        assert "--profile" in cmd
        assert "colbert-indexer" in cmd
        assert "colbert" not in cmd
        payload = json.loads(input or "{}")
        assert payload["colbert_index_dir"].startswith("/workspace/besedy/tmp/")
        assert payload["rows"] == [{"chunk_id": "chunk-1", "text": "ahoj"}]
        return subprocess.CompletedProcess(
            cmd,
            0,
            stdout='{"added_chunk_ids": ["chunk-1"], "retrieval_engine": "pylate"}',
            stderr="",
        )

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)
    monkeypatch.setattr(
        rag_colbert,
        "_http_json_request",
        lambda **_kwargs: pytest.fail(
            "docker-indexer incremental add should not use the long-lived Docker service"
        ),
    )

    result = rag_colbert._run_colbert_worker(
        command="add-to-index",
        payload={
            "colbert_index_dir": str(rag_colbert.PROJECT_ROOT / "tmp" / "colbert_index"),
            "rows": [{"chunk_id": "chunk-1", "text": "ahoj"}],
        },
    )

    assert result == {"added_chunk_ids": ["chunk-1"], "retrieval_engine": "pylate"}
    assert any("run" in command for command in seen_commands)
    assert all("ps" not in command for command in seen_commands)
    assert all("exec" not in command for command in seen_commands)


def test_run_colbert_worker_uses_docker_indexer_run_for_audit_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker-indexer")
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    seen_commands: list[list[str]] = []

    def fake_run(
        cmd: list[str],
        *,
        input: str | None = None,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, check
        seen_commands.append(cmd)
        assert cwd == rag_colbert.PROJECT_ROOT
        if "config" in cmd:
            return subprocess.CompletedProcess(
                cmd, 0, stdout="colbert\ncolbert-indexer\n", stderr=""
            )
        assert "run" in cmd
        assert "--profile" in cmd
        assert "colbert-indexer" in cmd
        payload = json.loads(input or "{}")
        assert payload == {"texts": ["a"], "colbert_model": "m", "doc_maxlen": 1}
        env_pairs = [cmd[index + 1] for index, value in enumerate(cmd[:-1]) if value == "-e"]
        assert f"TMPDIR={COLBERT_DOCKER_INDEXER_TMPDIR}" in env_pairs
        assert "TORCH_EXTENSIONS_DIR=/data/torch/extensions" in env_pairs
        assert not any(pair.startswith("BESEDY_COLBERT_BUNDLE_DIR=") for pair in env_pairs)
        return subprocess.CompletedProcess(
            cmd, 0, stdout='{"chunk_count": 1, "max_tokens": 1}', stderr=""
        )

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)
    monkeypatch.setattr(
        rag_colbert,
        "_http_json_request",
        lambda **_kwargs: pytest.fail(
            "docker-indexer audit should not use the long-lived Docker service"
        ),
    )

    result = rag_colbert._run_colbert_worker(
        command="audit-tokens",
        payload={"texts": ["a"], "colbert_model": "m", "doc_maxlen": 1},
    )

    assert result == {"chunk_count": 1, "max_tokens": 1}
    assert any("run" in command for command in seen_commands)
    assert all("ps" not in command for command in seen_commands)
    assert all("exec" not in command for command in seen_commands)


def test_run_colbert_worker_routes_queries_to_docker_service_when_runtime_is_docker_indexer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", "docker-indexer")
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    seen_commands: list[list[str]] = []
    seen_requests: list[tuple[str, str]] = []

    def fake_run(
        cmd: list[str],
        *,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, check
        seen_commands.append(cmd)
        assert cwd == rag_colbert.PROJECT_ROOT
        if "config" in cmd:
            return subprocess.CompletedProcess(
                cmd, 0, stdout="colbert\ncolbert-indexer\n", stderr=""
            )
        if "ps" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout="colbert\n", stderr="")
        pytest.fail(f"query-index should not use docker compose run: {cmd}")

    def fake_http_json_request(
        *,
        method: str,
        url: str,
        payload: dict[str, object] | None = None,
        timeout: float = 30.0,
    ) -> dict[str, object]:
        del payload, timeout
        seen_requests.append((method, url))
        if method == "GET":
            return {"ready": True}
        return {"hits": []}

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)
    monkeypatch.setattr(rag_colbert, "_http_json_request", fake_http_json_request)

    result = rag_colbert._run_colbert_worker(
        command="query-index",
        payload={
            "colbert_index_dir": str(rag_colbert.PROJECT_ROOT / "tmp" / "colbert_index"),
            "query": "rozpocet",
            "k": 5,
        },
    )

    assert result == {"hits": []}
    assert any("ps" in command for command in seen_commands)
    assert all("run" not in command for command in seen_commands)
    assert seen_requests[0][0] == "GET"
    assert seen_requests[1][0] == "POST"


@pytest.mark.parametrize("runtime", ["docker", "docker-indexer"])
def test_run_colbert_worker_uses_docker_one_shot_for_external_query_bundle(
    monkeypatch: pytest.MonkeyPatch,
    runtime: str,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", runtime)
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    seen_commands: list[list[str]] = []

    def fake_run(
        cmd: list[str],
        *,
        input: str | None = None,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, check
        seen_commands.append(cmd)
        assert cwd == rag_colbert.PROJECT_ROOT
        if "config" in cmd:
            services = "colbert\n"
            if runtime == "docker-indexer":
                services = "colbert\ncolbert-indexer\n"
            return subprocess.CompletedProcess(cmd, 0, stdout=services, stderr="")
        assert "run" in cmd
        assert "colbert" in cmd
        assert "env" in cmd
        volume_index = cmd.index("-v")
        assert (
            cmd[volume_index + 1]
            == "/tmp/external-colbert-bundle:/workspace/colbert-indexer-bundle:rw"
        )
        payload = json.loads(input or "{}")
        assert payload["colbert_index_dir"] == "/workspace/colbert-indexer-bundle/colbert_index"
        return subprocess.CompletedProcess(cmd, 0, stdout='{"hits": []}', stderr="")

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)
    monkeypatch.setattr(
        rag_colbert,
        "_http_json_request",
        lambda **_kwargs: pytest.fail(
            "external query bundle should not use the long-lived Docker service"
        ),
    )

    result = rag_colbert._run_colbert_worker(
        command="query-index",
        payload={
            "colbert_index_dir": "/tmp/external-colbert-bundle/colbert_index",
            "query": "rozpocet",
            "k": 5,
        },
    )

    assert result == {"hits": []}
    assert any("run" in command for command in seen_commands)
    assert all("ps" not in command for command in seen_commands)


@pytest.mark.parametrize("runtime", ["docker", "docker-indexer"])
def test_run_colbert_worker_accepts_prefixed_json_from_docker_one_shot(
    monkeypatch: pytest.MonkeyPatch,
    runtime: str,
) -> None:
    monkeypatch.setenv("BESEDY_COLBERT_RUNTIME", runtime)
    monkeypatch.setattr(
        rag_colbert.shutil,
        "which",
        lambda binary: "/usr/bin/docker" if binary == "docker" else None,
    )

    seen_commands: list[list[str]] = []

    def fake_run(
        cmd: list[str],
        *,
        input: str | None = None,
        text: bool,
        capture_output: bool,
        cwd: Path,
        check: bool,
        **_kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        del text, capture_output, check
        seen_commands.append(cmd)
        assert cwd == rag_colbert.PROJECT_ROOT
        if "config" in cmd:
            services = "colbert\n"
            if runtime == "docker-indexer":
                services = "colbert\ncolbert-indexer\n"
            return subprocess.CompletedProcess(cmd, 0, stdout=services, stderr="")
        assert "run" in cmd
        expected_service = "colbert-indexer" if runtime == "docker-indexer" else "colbert"
        assert expected_service in cmd
        payload = json.loads(input or "{}")
        assert payload["colbert_index_dir"] == "/workspace/besedy/tmp/colbert_index"
        return subprocess.CompletedProcess(
            cmd,
            0,
            stdout=(
                "==========\n== CUDA ==\n==========\n"
                '{"added_chunk_ids": ["chunk-1"], "retrieval_engine": "pylate"}'
            ),
            stderr="",
        )

    monkeypatch.setattr(rag_colbert.subprocess, "run", fake_run)

    result = rag_colbert._run_colbert_worker(
        command="add-to-index",
        payload={
            "colbert_index_dir": str(rag_colbert.PROJECT_ROOT / "tmp" / "colbert_index"),
            "rows": [{"chunk_id": "chunk-1"}],
        },
    )

    assert result == {"added_chunk_ids": ["chunk-1"], "retrieval_engine": "pylate"}
    assert any("run" in command for command in seen_commands)
    assert all("ps" not in command for command in seen_commands)


def test_lookup_colbert_chunks_maps_worker_payload(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    index_dir = tmp_path / "colbert_lookup"
    index_dir.mkdir()
    monkeypatch.setattr(
        rag_colbert,
        "_run_colbert_worker",
        lambda **_kwargs: {
            "chunks": [
                {
                    "chunk_id": "chunk-1",
                    "audio_hash": "a" * 64,
                    "chunk_ordinal": 3,
                    "start_sec": 1.0,
                    "end_sec": 3.0,
                    "text": "rozpocet a finance",
                    "run_id": "20260206_120000",
                    "backend_key": "faster-whisper/large-v3@silero_vad_v6",
                    "chunk_version": "v2",
                    "token_count": 3,
                    "source_path": "/tmp/transcript.json",
                }
            ]
        },
    )

    chunks = lookup_colbert_chunks(index_dir=index_dir, chunk_ids=["chunk-1"])

    assert len(chunks) == 1
    assert chunks[0].chunk_id == "chunk-1"
    assert chunks[0].chunk_ordinal == 3


def test_lookup_colbert_neighbors_maps_worker_payload(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    index_dir = tmp_path / "colbert_neighbors"
    index_dir.mkdir()
    monkeypatch.setattr(
        rag_colbert,
        "_run_colbert_worker",
        lambda **_kwargs: {
            "neighbors": {
                "chunk-1": {
                    "before": [
                        {
                            "chunk_id": "chunk-0",
                            "audio_hash": "a" * 64,
                            "chunk_ordinal": 0,
                            "start_sec": 0.0,
                            "end_sec": 1.0,
                            "text": "pred",
                            "run_id": "20260206_120000",
                            "backend_key": "faster-whisper/large-v3@silero_vad_v6",
                            "chunk_version": "v2",
                            "token_count": 1,
                            "source_path": "/tmp/transcript.json",
                        }
                    ],
                    "after": [],
                }
            }
        },
    )

    neighbors = lookup_colbert_neighbors(
        index_dir=index_dir, chunk_ids=["chunk-1"], neighbor_count=1
    )

    assert [chunk.chunk_id for chunk in neighbors["chunk-1"].before] == ["chunk-0"]
    assert neighbors["chunk-1"].after == []
