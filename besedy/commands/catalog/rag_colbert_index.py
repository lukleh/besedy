"""ColBERT sidecar index command."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from besedy.commands.catalog.rag_backend import resolve_pipeline_rag_backend_key
from besedy.core.paths import require_timestamped_transcripts_root, resolve_transcripts_root
from besedy.lib.rag_colbert import (
    COLBERT_RUNTIME_CHOICES,
    COLBERT_RUNTIME_ENV_VAR,
    DEFAULT_INDEX_BSIZE,
    DEFAULT_MAX_CHUNK_TOKENS,
    DEFAULT_MIN_CHUNK_TOKENS,
    DEFAULT_OVERLAP_TOKENS,
    default_colbert_index_runtime,
    resolve_default_colbert_model,
    sync_colbert_index,
)
from besedy.lib.rag_retrieval_chunking import normalize_backend_key


@dataclass
class RagColbertIndexRequest:
    group: str | None = None
    # None resolves like the pipeline: RAG_BACKEND_KEY, else the key derived
    # from the configured faster-whisper workflow.
    backend: str | None = None
    transcripts_root: Path | None = None
    index_dir: Path | None = None
    model: str = field(default_factory=resolve_default_colbert_model)
    chunk_tokenizer_model: str | None = None
    doc_maxlen: int = 384
    index_bsize: int = DEFAULT_INDEX_BSIZE
    use_faiss: bool = False
    target_audio_hash: str | None = None
    runtime: str | None = None
    force: bool = False
    rebuild: bool = False
    min_chunk_tokens: int = DEFAULT_MIN_CHUNK_TOKENS
    max_chunk_tokens: int = DEFAULT_MAX_CHUNK_TOKENS
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS
    json: bool = False

    @classmethod
    def from_args(
        cls,
        args: argparse.Namespace | "RagColbertIndexRequest",
    ) -> "RagColbertIndexRequest":
        if isinstance(args, cls):
            return args
        return cls(
            group=getattr(args, "group", None),
            backend=getattr(args, "backend", None),
            transcripts_root=getattr(args, "transcripts_root", None),
            index_dir=getattr(args, "index_dir", None),
            model=getattr(args, "model", None) or resolve_default_colbert_model(),
            chunk_tokenizer_model=getattr(args, "chunk_tokenizer_model", None),
            doc_maxlen=getattr(args, "doc_maxlen", 384),
            index_bsize=getattr(args, "index_bsize", DEFAULT_INDEX_BSIZE),
            use_faiss=bool(getattr(args, "use_faiss", False)),
            target_audio_hash=getattr(args, "target_audio_hash", None),
            runtime=getattr(args, "runtime", None),
            force=bool(getattr(args, "force", False)),
            rebuild=bool(getattr(args, "rebuild", False)),
            min_chunk_tokens=getattr(args, "min_chunk_tokens", DEFAULT_MIN_CHUNK_TOKENS),
            max_chunk_tokens=getattr(args, "max_chunk_tokens", DEFAULT_MAX_CHUNK_TOKENS),
            overlap_tokens=getattr(args, "overlap_tokens", DEFAULT_OVERLAP_TOKENS),
            json=bool(getattr(args, "json", False)),
        )


def _format_elapsed(seconds: float) -> str:
    total_seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    from besedy.commands.catalog.system import parse_positive_int

    parser = subparsers.add_parser(
        "rag-colbert-index",
        formatter_class=formatter_class,
        help="Sync a ColBERT sidecar index for one catalog + backend scope.",
        description=__doc__,
    )
    parser.add_argument(
        "--group",
        default=None,
        help=(
            "Catalog ID — the YYYYMMDD_HHMMSS timestamp that identifies a catalog. "
            "Default: extracted from the transcripts symlink target directory name."
        ),
    )
    parser.add_argument(
        "--backend",
        default=None,
        help=(
            "Backend key in '{workflow}/{model_component}' format "
            "(three-part '{workflow}/{model}/{vad}' is normalized). "
            "Default: RAG_BACKEND_KEY, else derived from the configured "
            "faster-whisper workflow."
        ),
    )
    parser.add_argument(
        "--transcripts-root",
        type=Path,
        default=None,
        help="Transcripts root (default: resolve from config, usually transcripts/ symlink).",
    )
    parser.add_argument(
        "--index-dir",
        type=Path,
        default=None,
        help="Optional explicit ColBERT sidecar directory override.",
    )
    parser.add_argument("--model", default=None)
    parser.add_argument(
        "--chunk-tokenizer-model",
        default=None,
        help=(
            "Tokenizer model used for chunk sizing. "
            "Default: use the active ColBERT model from --model."
        ),
    )
    parser.add_argument("--doc-maxlen", type=int, default=384)
    parser.add_argument(
        "--index-bsize",
        type=parse_positive_int,
        default=DEFAULT_INDEX_BSIZE,
        help=(
            "Inner ColBERT indexing batch size. Lower values reduce GPU VRAM use at the cost of speed. "
            f"Default: {DEFAULT_INDEX_BSIZE}."
        ),
    )
    parser.add_argument("--use-faiss", action="store_true")
    parser.add_argument(
        "--hash",
        dest="target_audio_hash",
        default=None,
        help="Optional audio hash to refresh within the selected backend scope.",
    )
    parser.add_argument(
        "--runtime",
        choices=COLBERT_RUNTIME_CHOICES,
        default=None,
        help=(
            "Optional ColBERT worker runtime override for this indexing run only. "
            f"Default: use {COLBERT_RUNTIME_ENV_VAR} when set, otherwise "
            "'docker-indexer' on GPU hosts and 'docker' on CPU-only hosts. "
            "Use 'docker' to force the CPU Docker ColBERT runtime."
        ),
    )
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="Discard incremental diffing and rebuild a fresh ColBERT bundle from current transcripts.",
    )
    parser.add_argument("--min-chunk-tokens", type=int, default=DEFAULT_MIN_CHUNK_TOKENS)
    parser.add_argument("--max-chunk-tokens", type=int, default=DEFAULT_MAX_CHUNK_TOKENS)
    parser.add_argument("--overlap-tokens", type=int, default=DEFAULT_OVERLAP_TOKENS)
    parser.add_argument("--json", action="store_true")
    parser.set_defaults(func=handle_rag_colbert_index)
    return parser


def handle_rag_colbert_index(
    args: argparse.Namespace | RagColbertIndexRequest,
) -> int:
    request = RagColbertIndexRequest.from_args(args)

    backend_key = request.backend
    if not backend_key:
        try:
            backend_key = resolve_pipeline_rag_backend_key(argparse.Namespace())
        except RuntimeError as exc:
            print(
                f"Error: cannot resolve a default backend key: {exc} Pass --backend explicitly.",
                file=sys.stderr,
            )
            return 1

    group = request.group
    if group is None:
        root = resolve_transcripts_root(request.transcripts_root)
        if root.is_symlink():
            root = root.resolve()
        group = require_timestamped_transcripts_root(root)

    effective_runtime = request.runtime
    if effective_runtime is None and os.getenv(COLBERT_RUNTIME_ENV_VAR) is None:
        effective_runtime = default_colbert_index_runtime()

    command_started_at = time.perf_counter()
    result = sync_colbert_index(
        workflow_group_id=group,
        backend_key=normalize_backend_key(backend_key),
        transcripts_root=request.transcripts_root,
        index_dir=request.index_dir,
        colbert_model=request.model,
        chunk_tokenizer_model=request.chunk_tokenizer_model,
        doc_maxlen=request.doc_maxlen,
        index_bsize=request.index_bsize,
        use_faiss=request.use_faiss,
        force=request.force,
        rebuild=request.rebuild,
        target_audio_hash=request.target_audio_hash,
        min_chunk_tokens=request.min_chunk_tokens,
        max_chunk_tokens=request.max_chunk_tokens,
        overlap_tokens=request.overlap_tokens,
        runtime=effective_runtime,
        progress_callback=(
            None if request.json else lambda message: print(message, file=sys.stderr, flush=True)
        ),
    )

    if request.json:
        print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
        return 0

    print("RAG ColBERT index complete")
    print(f"  workflow_group_id: {result.workflow_group_id}")
    print(f"  backend: {result.backend_key}")
    print(f"  run_id: {result.run_id}")
    print(f"  index_dir: {result.index_dir}")
    print(f"  model: {result.colbert_model}")
    if result.retrieval_engine is not None:
        print(f"  retrieval_engine: {result.retrieval_engine}")
    if result.index_format_version is not None:
        print(f"  index_format_version: {result.index_format_version}")
    if result.plaid_backend is not None:
        print(f"  plaid_backend: {result.plaid_backend}")
    if result.chunk_tokenizer_model is not None:
        print(f"  chunk_tokenizer_model: {result.chunk_tokenizer_model}")
    print(f"  doc_maxlen: {result.doc_maxlen}")
    print(f"  index_bsize: {result.index_bsize}")
    print(f"  use_faiss: {str(result.use_faiss).lower()}")
    print(f"  chunk_count: {result.chunk_count}")
    if result.sync_mode is not None:
        print(f"  sync_mode: {result.sync_mode}")
    if result.target_audio_hash is not None:
        print(f"  target_audio_hash: {result.target_audio_hash}")
    if (
        result.hashes_discovered
        or result.hashes_added
        or result.hashes_updated
        or result.hashes_removed
        or result.hashes_unchanged
        or result.hashes_failed
        or result.chunks_inserted
        or result.chunks_deleted
    ):
        print(f"  hashes_discovered: {result.hashes_discovered}")
        print(f"  hashes_added: {result.hashes_added}")
        print(f"  hashes_updated: {result.hashes_updated}")
        print(f"  hashes_removed: {result.hashes_removed}")
        print(f"  hashes_unchanged: {result.hashes_unchanged}")
        print(f"  hashes_failed: {result.hashes_failed}")
        print(f"  chunks_inserted: {result.chunks_inserted}")
        print(f"  chunks_deleted: {result.chunks_deleted}")
    print(
        "  overflow_chunks: "
        f"{result.token_audit.overflow_count} ({result.token_audit.overflow_fraction:.1%})"
    )
    print(f"  total_time: {_format_elapsed(time.perf_counter() - command_started_at)}")
    return 0


__all__ = ["handle_rag_colbert_index", "register_parser"]
