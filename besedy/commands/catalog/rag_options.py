"""ColBERT indexing options shared by ``run-pipeline`` and ``rag-colbert-index``.

``rag-colbert-index`` exposes these options unprefixed (``--index-dir``,
``--model`` ...); ``run-pipeline`` exposes the same options under ``--rag-*``
names (``--rag-colbert-index-dir``, ``--rag-colbert-model`` ...). Flag names,
defaults, help and parsing live here once; both parsers register them through
``add_rag_index_arguments`` and both handlers resolve them through
``resolve_rag_index_options``.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from besedy.commands.catalog.system import parse_positive_int
from besedy.lib.rag_colbert import (
    COLBERT_RUNTIME_CHOICES,
    COLBERT_RUNTIME_ENV_VAR,
    DEFAULT_DOC_MAXLEN,
    DEFAULT_INDEX_BSIZE,
    DEFAULT_MAX_CHUNK_TOKENS,
    DEFAULT_MIN_CHUNK_TOKENS,
    DEFAULT_OVERLAP_TOKENS,
    resolve_default_colbert_model,
)


@dataclass(frozen=True)
class RagIndexOptions:
    """ColBERT indexing options as parsed from either command line.

    ``model`` is already resolved to the active default when the flag was not
    given. ``runtime`` is the raw CLI override; each command applies its own
    environment/host default on top of it.
    """

    index_dir: Path | None
    model: str
    chunk_tokenizer_model: str | None
    doc_maxlen: int
    index_bsize: int
    runtime: str | None
    force: bool
    min_chunk_tokens: int
    max_chunk_tokens: int
    overlap_tokens: int


@dataclass(frozen=True)
class _RagOption:
    dest: str
    flag: str
    pipeline_flag: str
    kwargs: dict[str, Any]

    def dest_for(self, *, pipeline: bool) -> str:
        return (self.pipeline_flag if pipeline else self.flag).lstrip("-").replace("-", "_")


_RAG_OPTIONS: tuple[_RagOption, ...] = (
    _RagOption(
        "index_dir",
        "--index-dir",
        "--rag-colbert-index-dir",
        {
            "type": Path,
            "default": None,
            "help": "Optional explicit ColBERT sidecar directory override.",
        },
    ),
    _RagOption(
        "model",
        "--model",
        "--rag-colbert-model",
        {
            "default": None,
            "help": (
                "ColBERT checkpoint used for sidecar indexing. "
                "Default: RAG_COLBERT_MODEL, else [rag].colbert_model in besedy.toml, "
                "else the built-in default."
            ),
        },
    ),
    _RagOption(
        "chunk_tokenizer_model",
        "--chunk-tokenizer-model",
        "--rag-chunk-tokenizer-model",
        {
            "default": None,
            "help": (
                "Tokenizer model used for chunk sizing. Default: use the active ColBERT model."
            ),
        },
    ),
    _RagOption(
        "doc_maxlen",
        "--doc-maxlen",
        "--rag-colbert-doc-maxlen",
        {
            "type": int,
            "default": DEFAULT_DOC_MAXLEN,
            "help": "ColBERT doc_maxlen used for sidecar indexing.",
        },
    ),
    _RagOption(
        "index_bsize",
        "--index-bsize",
        "--rag-colbert-index-bsize",
        {
            "type": parse_positive_int,
            "default": DEFAULT_INDEX_BSIZE,
            "help": (
                "Inner ColBERT indexing batch size. Lower values reduce GPU VRAM use at the "
                f"cost of speed. Default: {DEFAULT_INDEX_BSIZE}."
            ),
        },
    ),
    _RagOption(
        "runtime",
        "--runtime",
        "--rag-colbert-runtime",
        {
            "choices": COLBERT_RUNTIME_CHOICES,
            "default": None,
            "help": (
                "Optional ColBERT worker runtime override for this indexing run only. "
                f"Default: use {COLBERT_RUNTIME_ENV_VAR} when set, otherwise "
                "'docker-indexer' on GPU hosts and 'docker' on CPU-only hosts. "
                "Use 'docker' to force the CPU Docker ColBERT runtime."
            ),
        },
    ),
    _RagOption(
        "force",
        "--force",
        "--rag-force",
        {
            "action": "store_true",
            "help": (
                "Force-refresh the ColBERT index for the selected scope even when "
                "transcripts are unchanged."
            ),
        },
    ),
    _RagOption(
        "min_chunk_tokens",
        "--min-chunk-tokens",
        "--rag-min-chunk-tokens",
        {
            "type": int,
            "default": DEFAULT_MIN_CHUNK_TOKENS,
            "help": "Minimum chunk token count for RAG ingest.",
        },
    ),
    _RagOption(
        "max_chunk_tokens",
        "--max-chunk-tokens",
        "--rag-max-chunk-tokens",
        {
            "type": int,
            "default": DEFAULT_MAX_CHUNK_TOKENS,
            "help": "Maximum chunk token count for RAG ingest.",
        },
    ),
    _RagOption(
        "overlap_tokens",
        "--overlap-tokens",
        "--rag-overlap-tokens",
        {
            "type": int,
            "default": DEFAULT_OVERLAP_TOKENS,
            "help": "Chunk overlap token count for RAG ingest.",
        },
    ),
)


def add_rag_index_arguments(parser: argparse.ArgumentParser, *, pipeline: bool = False) -> None:
    """Register the shared ColBERT indexing options on ``parser``.

    ``pipeline=True`` registers the ``--rag-*`` spellings used by ``run-pipeline``.
    """

    for option in _RAG_OPTIONS:
        parser.add_argument(option.pipeline_flag if pipeline else option.flag, **option.kwargs)


def resolve_rag_index_options(
    args: argparse.Namespace,
    *,
    pipeline: bool = False,
) -> RagIndexOptions:
    """Read the shared ColBERT indexing options from a parsed namespace.

    Missing attributes fall back to the flag defaults, so programmatic
    namespaces that set only a few options resolve like the command line.
    """

    values: dict[str, Any] = {}
    for option in _RAG_OPTIONS:
        default = option.kwargs.get("default", False)
        values[option.dest] = getattr(args, option.dest_for(pipeline=pipeline), default)
    values["model"] = values["model"] or resolve_default_colbert_model()
    values["force"] = bool(values["force"])
    return RagIndexOptions(**values)


__all__ = [
    "RagIndexOptions",
    "add_rag_index_arguments",
    "resolve_rag_index_options",
]
