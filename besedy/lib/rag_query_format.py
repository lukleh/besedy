"""Helpers for formatting embedding queries consistently across RAG tooling."""

from __future__ import annotations

from typing import Literal

EMBEDDING_QUERY_FORMATS = ("raw", "qwen-instruct")
DEFAULT_QWEN_EMBEDDING_QUERY_INSTRUCTION = (
    "Given a web search query, retrieve relevant passages that answer the query."
)

EmbeddingQueryFormat = Literal["raw", "qwen-instruct"]


def normalize_embedding_query_format(value: str) -> EmbeddingQueryFormat:
    """Validate the embedding query format without silent fallback."""

    normalized = value.strip().lower()
    if normalized in EMBEDDING_QUERY_FORMATS:
        return normalized
    supported = ", ".join(EMBEDDING_QUERY_FORMATS)
    raise ValueError(f"Invalid embedding query format: {value!r}. Expected one of: {supported}")


def resolve_embedding_query_instruction(
    *,
    query_format: EmbeddingQueryFormat,
    query_instruction: str | None = None,
) -> str | None:
    """Return the effective instruction string for the selected format."""

    if query_format == "raw":
        return None

    instruction = (query_instruction or DEFAULT_QWEN_EMBEDDING_QUERY_INSTRUCTION).strip()
    if not instruction:
        raise ValueError("embedding_query_instruction must not be empty for instructed queries.")
    return instruction


def format_embedding_query(
    query: str,
    *,
    query_format: EmbeddingQueryFormat = "raw",
    query_instruction: str | None = None,
) -> str:
    """Format one query string for embedding without affecting sparse/rerank text."""

    normalized_query = query.strip()
    if query_format == "raw":
        return normalized_query

    instruction = resolve_embedding_query_instruction(
        query_format=query_format,
        query_instruction=query_instruction,
    )
    return f"Instruct: {instruction}\nQuery: {normalized_query}"


__all__ = [
    "DEFAULT_QWEN_EMBEDDING_QUERY_INSTRUCTION",
    "EMBEDDING_QUERY_FORMATS",
    "EmbeddingQueryFormat",
    "format_embedding_query",
    "normalize_embedding_query_format",
    "resolve_embedding_query_instruction",
]
