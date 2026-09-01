#!/usr/bin/env python3
"""Backfill FTS5 indexes in existing RAG chunk-store bundles."""

from __future__ import annotations

import argparse
from pathlib import Path

from besedy.lib.rag_chunk_store import ensure_chunk_store_fts


def discover_chunk_stores(roots: list[Path]) -> list[Path]:
    stores: set[Path] = set()
    for root in roots:
        resolved = root.resolve()
        if resolved.is_file() and resolved.name == "chunk_store.sqlite":
            stores.add(resolved)
            continue
        direct_store = resolved / "chunk_store.sqlite"
        if resolved.is_dir() and direct_store.is_file():
            stores.add(direct_store.resolve())
            continue
        if not resolved.exists():
            raise FileNotFoundError(f"Chunk-store root does not exist: {root}")
        raise ValueError(
            "Supply an explicit active index directory or chunk_store.sqlite file; "
            f"recursive bundle-root backfills are not supported: {root}"
        )
    return sorted(stores)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "roots",
        nargs="+",
        type=Path,
        help="Explicit active index directories or chunk_store.sqlite files.",
    )
    args = parser.parse_args()

    stores = discover_chunk_stores(args.roots)
    if not stores:
        parser.error("No chunk_store.sqlite files found under the supplied roots.")

    for store in stores:
        ensure_chunk_store_fts(path=store)
        print(f"FTS ready: {store}")
    print(f"Prepared {len(stores)} chunk store(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
