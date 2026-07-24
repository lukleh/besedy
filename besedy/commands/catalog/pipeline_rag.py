"""RAG/ColBERT helpers shared by catalog pipeline entrypoints."""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Callable
from pathlib import Path

from besedy.commands.catalog.rag_backend import (
    default_pipeline_rag_backend_key,
    rag_backend_key_for_workflow,
    resolve_pipeline_rag_backend_key,
)
from besedy.commands.catalog.rag_colbert_index import (
    RagColbertIndexRequest,
    handle_rag_colbert_index,
)
from besedy.lib.rag_chunk_corpus import slugify_backend_key
from besedy.lib.rag_colbert import (
    COLBERT_RUNTIME_CHOICES,
    COLBERT_RUNTIME_ENV_VAR,
    DEFAULT_INDEX_BSIZE,
    DEFAULT_MAX_CHUNK_TOKENS,
    DEFAULT_MIN_CHUNK_TOKENS,
    DEFAULT_OVERLAP_TOKENS,
    check_colbert_runtime_ready,
    default_colbert_index_runtime,
    resolve_default_colbert_model,
)
from besedy.lib.workflow.config import WorkflowConfig

__all__ = [
    "COLBERT_RUNTIME_CHOICES",
    "COLBERT_RUNTIME_ENV_VAR",
    "DEFAULT_INDEX_BSIZE",
    "DEFAULT_MAX_CHUNK_TOKENS",
    "DEFAULT_MIN_CHUNK_TOKENS",
    "DEFAULT_OVERLAP_TOKENS",
    "backend_has_transcripts",
    "default_pipeline_rag_backend_key",
    "rag_backend_key_for_workflow",
    "run_rag_colbert_index_for_workflow",
    "select_rag_workflows",
    "should_run_rag_colbert_index",
    "_resolve_pipeline_colbert_runtime",
    "_resolve_pipeline_rag_backend_key",
]


def backend_has_transcripts(transcripts_root: Path, workflow: WorkflowConfig) -> bool:
    """Return True when a workflow has at least one transcript.json on disk."""

    backend_key = rag_backend_key_for_workflow(workflow)
    workflow_dir, model_component = backend_key.split("/", maxsplit=1)
    backend_dir = transcripts_root / workflow_dir / model_component
    if not backend_dir.exists():
        return False
    return any(path.is_file() for path in backend_dir.rglob("transcript.json"))


def _resolve_pipeline_rag_backend_key(args: argparse.Namespace) -> str:
    """Compatibility wrapper for callers importing the historical private helper."""

    return resolve_pipeline_rag_backend_key(args)


def select_rag_workflows(
    args: argparse.Namespace,
    workflows: list[WorkflowConfig],
    *,
    resolve_backend_key: Callable[[argparse.Namespace], str] = _resolve_pipeline_rag_backend_key,
) -> tuple[list[WorkflowConfig], str | None]:
    """Return workflows that should be RAG-indexed for this pipeline run."""

    if bool(getattr(args, "rag_all_backends", False)):
        return list(workflows), None

    target_backend = resolve_backend_key(args)
    selected = [
        workflow
        for workflow in workflows
        if rag_backend_key_for_workflow(workflow) == target_backend
    ]
    return selected, target_backend


def should_run_rag_colbert_index(
    args: argparse.Namespace,
    *,
    resolve_runtime: Callable[[argparse.Namespace], str] = lambda args: (
        _resolve_pipeline_colbert_runtime(args)
    ),
    runtime_ready_check: Callable[[str], object] = check_colbert_runtime_ready,
) -> bool:
    """Return True when pipeline ColBERT indexing should run."""

    if bool(getattr(args, "skip_rag_colbert_index", False)):
        return False

    try:
        runtime_ready_check(resolve_runtime(args))
    except RuntimeError as exc:
        print(f"Note: skipping rag-colbert-index because {exc}", file=sys.stderr)
        return False

    return True


def _resolve_pipeline_colbert_runtime(
    args: argparse.Namespace,
    *,
    default_runtime_resolver: Callable[[], str] = default_colbert_index_runtime,
) -> str:
    runtime = getattr(args, "rag_colbert_runtime", None)
    if runtime is not None:
        return runtime
    if os.getenv(COLBERT_RUNTIME_ENV_VAR) is not None:
        return os.getenv(COLBERT_RUNTIME_ENV_VAR, "")
    return default_runtime_resolver()


def _resolve_pipeline_colbert_index_dir(
    args: argparse.Namespace,
    *,
    backend_key: str,
) -> Path | None:
    explicit_index_dir = getattr(args, "rag_colbert_index_dir", None)
    if explicit_index_dir is None:
        return None

    resolved_index_dir = Path(explicit_index_dir)
    if bool(getattr(args, "_pipeline_multi_rag_backend_selection", False)):
        return resolved_index_dir / slugify_backend_key(backend_key)

    return resolved_index_dir


def run_rag_colbert_index_for_workflow(
    args: argparse.Namespace,
    *,
    workflow_group_id: str,
    transcripts_root: Path,
    workflow: WorkflowConfig,
    has_transcripts: Callable[[Path, WorkflowConfig], bool] = backend_has_transcripts,
    resolve_runtime: Callable[[argparse.Namespace], str] = lambda args: (
        _resolve_pipeline_colbert_runtime(args)
    ),
    resolve_index_dir: Callable[
        [argparse.Namespace, str], Path | None
    ] = lambda args, backend_key: _resolve_pipeline_colbert_index_dir(
        args, backend_key=backend_key
    ),
    handle_index: Callable[[RagColbertIndexRequest], int] = handle_rag_colbert_index,
) -> int:
    """Run ColBERT sidecar indexing for one transcription workflow."""

    backend_key = rag_backend_key_for_workflow(workflow)
    if not has_transcripts(transcripts_root, workflow):
        print(f"No transcripts found for {backend_key}; skipping rag-colbert-index.")
        return 0

    colbert_args = RagColbertIndexRequest(
        group=workflow_group_id,
        backend=backend_key,
        transcripts_root=transcripts_root,
        index_dir=resolve_index_dir(args, backend_key),
        model=getattr(args, "rag_colbert_model", None) or resolve_default_colbert_model(),
        chunk_tokenizer_model=getattr(args, "rag_chunk_tokenizer_model", None),
        doc_maxlen=getattr(args, "rag_colbert_doc_maxlen", 384),
        index_bsize=getattr(args, "rag_colbert_index_bsize", DEFAULT_INDEX_BSIZE),
        use_faiss=bool(getattr(args, "rag_colbert_use_faiss", False)),
        force=bool(getattr(args, "rag_force", False)),
        min_chunk_tokens=getattr(args, "rag_min_chunk_tokens", DEFAULT_MIN_CHUNK_TOKENS),
        max_chunk_tokens=getattr(args, "rag_max_chunk_tokens", DEFAULT_MAX_CHUNK_TOKENS),
        overlap_tokens=getattr(args, "rag_overlap_tokens", DEFAULT_OVERLAP_TOKENS),
        runtime=resolve_runtime(args),
        json=False,
    )
    return handle_index(colbert_args)
