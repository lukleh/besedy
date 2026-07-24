#!/usr/bin/env python3
"""Persistent ColBERT query server for the Docker runtime."""

from __future__ import annotations

import argparse
import json
import os
import threading
from http import HTTPStatus
from pathlib import Path
from typing import Any

from besedy.lib import rag_pylate
from besedy.lib.http_server import JsonApiHandler, serve_threading_http_server
from besedy.lib.rag_bundle import resolve_colbert_scope_bundle, validate_colbert_bundle
from besedy.lib.rag_colbert_runtime.worker import (
    _call_with_supported_kwargs,
    _lookup_chunks,
    _lookup_neighbors,
)

PRELOAD_INDEX_ENV_VAR = "COLBERT_PRELOAD_INDEX_DIR"


class ColbertQueryService:
    """Keep one ColBERT index warm and reuse it across queries."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._loaded_index_key: str | None = None
        self._model: Any | None = None
        self._retriever: Any | None = None
        self._device: str | None = None
        self._plaid_backend: str | None = None

    def health(self) -> dict[str, Any]:
        with self._lock:
            return {
                "ready": True,
                "loaded_index_dir": self._loaded_index_key,
                "retrieval_engine": rag_pylate.PYLATE_RETRIEVAL_ENGINE,
                "plaid_backend": self._plaid_backend,
            }

    def query(self, payload: dict[str, Any]) -> dict[str, Any]:
        query = str(payload.get("query", "")).strip()
        if not query:
            raise ValueError("Query must not be empty.")

        raw_index_dir = payload.get("colbert_index_dir")
        if not isinstance(raw_index_dir, str) or not raw_index_dir.strip():
            raise ValueError("colbert_index_dir is required.")

        k = int(payload.get("k", 10))
        if k <= 0:
            raise ValueError("k must be positive.")
        force_fast = bool(payload.get("force_fast", False))

        resolved_index_dir = Path(raw_index_dir).resolve()
        if not resolved_index_dir.exists():
            raise FileNotFoundError(f"ColBERT index directory does not exist: {resolved_index_dir}")

        if force_fast:
            # Keep accepting the legacy flag during migration, but PyLate does not
            # expose a direct equivalent for Besedy's old query path.
            force_fast = False

        model, retriever, device = self._ensure_loaded_runtime(resolved_index_dir)
        query_embeddings = model.encode(
            [query],
            batch_size=1,
            is_query=True,
            show_progress_bar=False,
        )
        results = _call_with_supported_kwargs(
            retriever.retrieve,
            queries_embeddings=query_embeddings,
            k=k,
            device=device,
            batch_size=1,
        )
        return {
            "hits": rag_pylate.normalize_pylate_hits(results),
            "loaded_index_dir": str(resolved_index_dir),
        }

    def resolve(self, payload: dict[str, Any]) -> dict[str, Any]:
        explicit_index_dir = payload.get("explicit_index_dir")
        if isinstance(explicit_index_dir, str) and explicit_index_dir.strip():
            normalized_index_dir = _normalize_index_dir(explicit_index_dir)
            artifacts = validate_colbert_bundle(normalized_index_dir.parent)
            return {
                "colbert_index_dir": str(artifacts.colbert_index_dir),
            }

        workflow_group_id = str(payload.get("workflow_group_id", "")).strip()
        backend_key = str(payload.get("backend_key", "")).strip()
        colbert_model = str(payload.get("colbert_model", "")).strip()
        if not workflow_group_id or not backend_key or not colbert_model:
            raise ValueError(
                "workflow_group_id, backend_key, and colbert_model are required when explicit_index_dir is unset."
            )

        raw_chunk_version = payload.get("chunk_version")
        chunk_version = (
            str(raw_chunk_version).strip() if isinstance(raw_chunk_version, str) else None
        )
        raw_root_dir = payload.get("colbert_root_dir")
        root_dir = (
            str(raw_root_dir).strip()
            if isinstance(raw_root_dir, str) and raw_root_dir.strip()
            else None
        )

        bundle = resolve_colbert_scope_bundle(
            workflow_group_id=workflow_group_id,
            backend_key=backend_key,
            colbert_model=colbert_model,
            chunk_version=chunk_version,
            root_dir=root_dir,
        )
        if bundle is None:
            raise FileNotFoundError(
                f"No valid ColBERT bundle found for {workflow_group_id} / {backend_key} / {colbert_model}."
            )
        return {
            "colbert_index_dir": str(bundle.artifacts.colbert_index_dir),
            "chunk_version": bundle.chunk_version,
            "bundle_dir": str(bundle.artifacts.bundle_dir),
        }

    def lookup(self, payload: dict[str, Any]) -> dict[str, Any]:
        return _lookup_chunks(payload)

    def neighbors(self, payload: dict[str, Any]) -> dict[str, Any]:
        return _lookup_neighbors(payload)

    def preload(self, raw_index_dir: str) -> None:
        resolved_index_dir = Path(raw_index_dir).resolve()
        if not resolved_index_dir.exists():
            raise FileNotFoundError(
                f"ColBERT preload index directory does not exist: {resolved_index_dir}"
            )
        self._ensure_loaded_runtime(resolved_index_dir)

    def _ensure_loaded_runtime(self, resolved_index_dir: Path) -> tuple[Any, Any, str]:
        key = str(resolved_index_dir)
        with self._lock:
            if (
                self._loaded_index_key != key
                or self._model is None
                or self._retriever is None
                or self._device is None
            ):
                artifacts = validate_colbert_bundle(resolved_index_dir.parent)
                meta = json.loads(artifacts.index_meta_path.read_text(encoding="utf-8"))
                if not isinstance(meta, dict):
                    raise RuntimeError(
                        f"Invalid ColBERT bundle metadata at {artifacts.index_meta_path}"
                    )
                colbert_model = str(meta["colbert_model"])
                doc_maxlen = int(meta.get("doc_maxlen", 384))
                plaid_backend = rag_pylate.normalize_plaid_backend(
                    str(meta.get("plaid_backend", "fast"))
                )
                device = rag_pylate.resolve_pylate_device()
                self._model = rag_pylate.build_pylate_model(
                    colbert_model=colbert_model,
                    device=device,
                    doc_maxlen=doc_maxlen,
                )
                index = rag_pylate.open_pylate_index(
                    index_dir=resolved_index_dir,
                    plaid_backend=plaid_backend,
                    override=False,
                    device=device,
                )
                self._retriever = rag_pylate.create_pylate_retriever(index=index)
                self._device = device
                self._plaid_backend = plaid_backend
                self._loaded_index_key = key
            return self._model, self._retriever, self._device


SERVICE = ColbertQueryService()


class ColbertQueryHandler(JsonApiHandler):
    server_version = "BesedyColBERT/1.0"

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        self._write_json(HTTPStatus.OK, SERVICE.health())

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in {"/query", "/resolve", "/lookup", "/neighbors"}:
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return

        self._dispatch_json(self._handle_post)

    def _handle_post(self) -> dict[str, Any]:
        payload = self._read_json_payload()
        if self.path == "/query":
            return SERVICE.query(payload)
        if self.path == "/resolve":
            return SERVICE.resolve(payload)
        if self.path == "/lookup":
            return SERVICE.lookup(payload)
        return SERVICE.neighbors(payload)


def _normalize_index_dir(raw_index_dir: str) -> Path:
    resolved = Path(raw_index_dir).resolve()
    if resolved.name == "colbert_index":
        return resolved
    return resolved / "colbert_index"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8192)
    parser.add_argument("--preload-index-dir")
    args = parser.parse_args(argv)

    preload_index_dir = (
        args.preload_index_dir or os.getenv(PRELOAD_INDEX_ENV_VAR, "").strip() or None
    )
    if preload_index_dir is not None:
        try:
            SERVICE.preload(preload_index_dir)
            print(f"Preloaded ColBERT index: {Path(preload_index_dir).resolve()}", flush=True)
        except FileNotFoundError as exc:
            print(
                f"Skipping ColBERT preload because the index path is missing: {exc}",
                flush=True,
            )

    serve_threading_http_server(
        host=args.host,
        port=args.port,
        handler=ColbertQueryHandler,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
