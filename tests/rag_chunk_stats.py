#!/usr/bin/env python3
"""Measure actual token counts for RAG chunk artifacts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from besedy.lib.rag_retrieval_chunking import (
    CHUNK_TOKENIZER_MODEL,
    get_chunk_token_counter,
    measure_chunk_texts,
)


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _resolve_index_meta_path(chunks_jsonl: Path, explicit_path: Path | None) -> Path | None:
    if explicit_path is not None:
        return explicit_path

    candidate = chunks_jsonl.parent / "index_meta.json"
    return candidate if candidate.exists() else None


def _read_chunk_texts(chunks_jsonl: Path, *, limit: int | None) -> list[str]:
    texts: list[str] = []
    with chunks_jsonl.open("r", encoding="utf-8") as handle:
        for line in handle:
            if limit is not None and len(texts) >= limit:
                break
            record = json.loads(line)
            text = str(record.get("text", "")).strip()
            if text:
                texts.append(text)
    return texts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chunks-jsonl", type=Path, required=True)
    parser.add_argument("--index-meta", type=Path, default=None)
    parser.add_argument(
        "--limit", type=int, default=None, help="Optional max number of chunks to measure."
    )
    parser.add_argument("--min-chunk-tokens", type=int, default=None)
    parser.add_argument("--max-chunk-tokens", type=int, default=None)
    parser.add_argument("--tokenizer-model", default=None)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    if args.limit is not None and args.limit <= 0:
        raise ValueError("--limit must be positive when provided.")

    meta_path = _resolve_index_meta_path(args.chunks_jsonl, args.index_meta)
    meta = _load_json(meta_path) if meta_path is not None and meta_path.exists() else {}
    chunking_meta = meta.get("chunking", {}) if isinstance(meta, dict) else {}
    distribution_meta = meta.get("chunk_distribution", {}) if isinstance(meta, dict) else {}

    tokenizer_model = (
        args.tokenizer_model or chunking_meta.get("tokenizer_model") or CHUNK_TOKENIZER_MODEL
    )
    min_chunk_tokens = int(args.min_chunk_tokens or chunking_meta.get("min_chunk_tokens") or 220)
    max_chunk_tokens = int(args.max_chunk_tokens or chunking_meta.get("max_chunk_tokens") or 300)
    overflow_single_segment_count = int(distribution_meta.get("overflow_single_segment_count") or 0)

    texts = _read_chunk_texts(args.chunks_jsonl, limit=args.limit)
    token_counter = get_chunk_token_counter(model_name=str(tokenizer_model))
    distribution = measure_chunk_texts(
        texts,
        token_counter=token_counter,
        min_tokens=min_chunk_tokens,
        max_tokens=max_chunk_tokens,
        overflow_single_segment_count=overflow_single_segment_count,
    )

    payload = {
        "chunks_jsonl": str(args.chunks_jsonl),
        "index_meta": str(meta_path) if meta_path is not None else None,
        "measured_chunks": distribution.chunk_count,
        "distribution": distribution.__dict__,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print("RAG chunk token stats")
        print(f"  chunks_jsonl: {payload['chunks_jsonl']}")
        print(f"  tokenizer_model: {distribution.tokenizer_model}")
        print(f"  target_band: {distribution.target_min_tokens}-{distribution.target_max_tokens}")
        print(f"  measured_chunks: {distribution.chunk_count}")
        print(
            "  tokens: "
            f"min={distribution.min_tokens} median={distribution.median_tokens:.1f} "
            f"mean={distribution.mean_tokens:.1f} max={distribution.max_tokens}"
        )
        print(
            "  coverage: "
            f"within={distribution.within_target_count} ({distribution.within_target_fraction:.1%}), "
            f"below={distribution.below_target_count} ({distribution.below_target_fraction:.1%}), "
            f"above={distribution.above_target_count} ({distribution.above_target_fraction:.1%})"
        )
        print(
            "  overflow_single_segments: "
            f"{distribution.overflow_single_segment_count} "
            f"({distribution.overflow_single_segment_fraction:.1%})"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
