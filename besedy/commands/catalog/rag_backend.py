"""Resolve configured transcript backends for catalog RAG commands."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from dotenv import dotenv_values

from besedy.core.paths import PROJECT_ROOT, iter_existing_web_env_paths
from besedy.lib.rag_retrieval_chunking import normalize_backend_key
from besedy.lib.workflow.config import WorkflowConfig, get_transcription_workflows
from besedy.lib.workflow.paths import sanitize_model_identifier


def rag_backend_key_for_workflow(workflow: WorkflowConfig) -> str:
    """Return the RAG backend key matching the transcript directory layout."""

    model_component = workflow.output_component(sanitize_model_identifier)
    return f"{workflow.workflow_label}/{model_component}"


def default_pipeline_rag_backend_key() -> str:
    """Derive the default RAG backend key from the configured faster-whisper workflow."""

    workflows = get_transcription_workflows(workflow_id="faster-whisper", pipeline_only=True)
    if not workflows:
        workflows = get_transcription_workflows(workflow_id="faster-whisper")
    if not workflows:
        raise RuntimeError("No faster-whisper workflow configured in besedy.toml.")
    return rag_backend_key_for_workflow(workflows[0])


def resolve_pipeline_rag_backend_key(args: argparse.Namespace) -> str:
    """Resolve an explicit, deployed, environment, or configured RAG backend key."""

    explicit_backend = getattr(args, "rag_backend", None)
    if isinstance(explicit_backend, str) and explicit_backend.strip():
        return normalize_backend_key(explicit_backend)

    candidates = [
        *iter_existing_web_env_paths("production"),
        PROJECT_ROOT / "web" / ".env.local",
        PROJECT_ROOT / ".env.local",
        *iter_existing_web_env_paths("development", "test"),
    ]
    deduped_candidates: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen or not candidate.exists():
            continue
        seen.add(candidate)
        deduped_candidates.append(candidate)

    for env_file in deduped_candidates:
        values = dotenv_values(env_file)
        file_backend = values.get("RAG_BACKEND_KEY")
        if isinstance(file_backend, str) and file_backend.strip():
            return normalize_backend_key(file_backend)

    env_backend = os.getenv("RAG_BACKEND_KEY", "").strip()
    if env_backend:
        return normalize_backend_key(env_backend)

    return default_pipeline_rag_backend_key()


__all__ = [
    "default_pipeline_rag_backend_key",
    "rag_backend_key_for_workflow",
    "resolve_pipeline_rag_backend_key",
]
