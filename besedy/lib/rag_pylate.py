"""Shared PyLate helpers for the ColBERT sidecar runtime."""

from __future__ import annotations

from pathlib import Path
from typing import Any

PYLATE_RETRIEVAL_ENGINE = "pylate"
PYLATE_INDEX_FORMAT_VERSION = "pylate-v1"
DEFAULT_PYLATE_PLAID_BACKEND = "fast"
SUPPORTED_PYLATE_PLAID_BACKENDS = ("fast", "stanford")
PYLATE_QUERY_PREFIX = "[QueryMarker]"
PYLATE_DOCUMENT_PREFIX = "[DocumentMarker]"
PYLATE_ATTEND_TO_EXPANSION_TOKENS = True


def normalize_plaid_backend(raw_value: str | None) -> str:
    normalized = (raw_value or DEFAULT_PYLATE_PLAID_BACKEND).strip().lower()
    if normalized in SUPPORTED_PYLATE_PLAID_BACKENDS:
        return normalized

    expected = ", ".join(repr(choice) for choice in SUPPORTED_PYLATE_PLAID_BACKENDS)
    raise ValueError(
        f"Unsupported PyLate PLAID backend: {raw_value!r}. Expected one of: {expected}."
    )


def resolve_pylate_device(preferred: str | None = None) -> str:
    if preferred is not None and preferred.strip():
        return preferred.strip()

    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


def get_pylate_version() -> str:
    from pylate.__version__ import __version__ as pylate_version

    return str(pylate_version)


def get_engine_metadata(
    *, plaid_backend: str | None = None, retrieval_engine_version: str | None = None
) -> dict[str, str]:
    return {
        "retrieval_engine": PYLATE_RETRIEVAL_ENGINE,
        "retrieval_engine_version": retrieval_engine_version or get_pylate_version(),
        "index_format_version": PYLATE_INDEX_FORMAT_VERSION,
        "plaid_backend": normalize_plaid_backend(plaid_backend),
    }


def build_pylate_model(
    *,
    colbert_model: str,
    device: str | None = None,
    doc_maxlen: int | None = None,
):
    from pylate import models

    kwargs: dict[str, Any] = {
        "model_name_or_path": colbert_model,
        "query_prefix": PYLATE_QUERY_PREFIX,
        "document_prefix": PYLATE_DOCUMENT_PREFIX,
        "attend_to_expansion_tokens": PYLATE_ATTEND_TO_EXPANSION_TOKENS,
        "trust_remote_code": True,
        "device": resolve_pylate_device(device),
    }
    if doc_maxlen is not None:
        kwargs["document_length"] = int(doc_maxlen)

    return models.ColBERT(
        **kwargs,
    )


def open_pylate_index(
    *,
    index_dir: Path | str,
    plaid_backend: str | None = None,
    override: bool = False,
    device: str | None = None,
):
    from pylate import indexes

    resolved_index_dir = Path(index_dir).resolve()
    resolved_index_dir.parent.mkdir(parents=True, exist_ok=True)
    backend = normalize_plaid_backend(plaid_backend)
    return indexes.PLAID(
        index_folder=str(resolved_index_dir.parent),
        index_name=resolved_index_dir.name,
        override=override,
        use_fast=(backend == "fast"),
        show_progress=False,
        device=resolve_pylate_device(device),
    )


def create_pylate_retriever(*, index):
    from pylate import retrieve

    return retrieve.ColBERT(index=index)


def normalize_pylate_hits(raw_results: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_results, list):
        raise RuntimeError(f"Unexpected PyLate retrieval result shape: {type(raw_results)!r}")

    rows = raw_results
    if rows and isinstance(rows[0], list):
        rows = rows[0]
    if not isinstance(rows, list):
        raise RuntimeError(f"Unexpected PyLate retrieval result nesting: {type(rows)!r}")

    hits: list[dict[str, Any]] = []
    for rank, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            continue
        normalized = dict(row)
        chunk_id = (
            normalized.get("chunk_id") or normalized.get("id") or normalized.get("document_id")
        )
        if chunk_id is not None:
            normalized["chunk_id"] = str(chunk_id)
            normalized.setdefault("document_id", str(chunk_id))
        normalized.setdefault("rank", rank)
        hits.append(normalized)
    return hits


__all__ = [
    "DEFAULT_PYLATE_PLAID_BACKEND",
    "PYLATE_INDEX_FORMAT_VERSION",
    "PYLATE_RETRIEVAL_ENGINE",
    "SUPPORTED_PYLATE_PLAID_BACKENDS",
    "build_pylate_model",
    "create_pylate_retriever",
    "get_engine_metadata",
    "get_pylate_version",
    "normalize_plaid_backend",
    "normalize_pylate_hits",
    "open_pylate_index",
    "resolve_pylate_device",
]
