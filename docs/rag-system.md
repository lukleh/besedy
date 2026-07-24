# RAG System

> **Last Updated:** 2026-04-04

## Decision Summary

- ColBERT sidecar is the primary (and only) retrieval path. The web search route is ColBERT-only.
- Chunk hydration and neighbor lookup come from the ColBERT bundle, not PostgreSQL.
- PostgreSQL is used only for ACL filtering, catalog visibility, and recording metadata. No chunk-level RAG state lives in Postgres.
- TEI is optional and only used for ColBERT reranking when `RAG_COLBERT_RERANK_ENABLED=true` (default: `false`).
- The engine layer is PyLate/FastPLAID. Besedy does not rely on live in-place mutation of serving bundles because the library runtime does not provide transactional cutover.

## Model Licensing

The **default** ColBERT retriever, `jinaai/jina-colbert-v2`, is **CC-BY-NC-4.0
(non-commercial)** -- do not use it in a commercial deployment. For commercial
use, switch to a permissively-licensed ColBERT model via the `RAG_COLBERT_MODEL`
environment variable or `--rag-colbert-model` (e.g. `colbert-ir/colbertv2.0`;
verify its terms on the model card). The default dense embedder (`BAAI/bge-m3`,
MIT) and reranker / chunk tokenizer (`Alibaba-NLP/gte-multilingual-reranker-base`,
Apache-2.0) are commercial-friendly. See the [full model and license table in the
README](../README.md#third-party-models--licenses) for the source of truth.

## Query Flow

Search entrypoint: `POST /api/catalogs/:id/search`.

1. The web route asks the ColBERT sidecar to resolve the active validated bundle for the current `(workflow_group_id, backend_key, colbert_model)` scope.
2. The route queries the sidecar with that bundle.
3. Candidate `audio_hash` values are filtered through PostgreSQL using recording visibility and metadata constraints.
4. Surviving chunks and their neighbors are hydrated from the sidecar bundle's `chunk_store.sqlite`.
5. Results are optionally reranked with TEI if `RAG_COLBERT_RERANK_ENABLED=true`.

Behavioral defaults:

- ColBERT can overfetch before post-filtering when ACL or metadata filters would otherwise shrink the result set.
- Listener-visible results stay scoped to actionable and published recordings.

## Chunking

Current defaults (from the April 3, 2026 tuning pass):

| Parameter | Value | Rationale |
| --- | --- | --- |
| `min_chunk_tokens` | 180 | Floor for semantic density per chunk |
| `max_chunk_tokens` | 260 | Ceiling before forced split |
| `overlap_tokens` | 40 | Context bridging between adjacent chunks |
| `doc_maxlen` | 384 | ColBERT token budget per passage |

These are the current supported settings. All four participate in the `chunking_fingerprint` used by incremental sync (see below).

## Bundle Layout

Bundles live under:

```text
tmp/rag_colbert/<workflow_group_id>/<backend_slug>/<chunk_version>/<model_slug>/
  index -> index_YYYYMMDD_HHMMSS/
```

Each active runtime bundle must contain:

| Artifact | Role |
| --- | --- |
| `colbert_index/` | PLAID index files |
| `index_meta.json` | Runtime metadata (counts, timestamps, config) |
| `chunk_store.sqlite` | Canonical chunk hydration and neighbor lookup |
| `source_state.sqlite` | Incremental sync state (per-`audio_hash` fingerprints) |

Optional:

- `chunk_manifest.jsonl` -- debug/export artifact, rewritten from chunk store at cutover.

### Active bundle selection

Active bundle selection is model-scoped. The sidecar first checks the explicit `active_<model_slug>.json` pointer under the backend root, then falls back to the latest valid bundle for that scope. Incremental cutover updates both the model-scoped `index` symlink and the active-pointer file so `/resolve` and direct-path users converge on the same bundle.

## Indexing

### Commands

```bash
just catalog rag-colbert-index ...
# or directly:
uv run python besedy/cli/catalog.py rag-colbert-index ...
```

### Runtime selection

- Default runtime: `docker-indexer` on GPU hosts, `docker` on CPU-only hosts (when `BESEDY_COLBERT_RUNTIME` is unset).
- Use `--runtime docker` only when you intentionally want the CPU Docker ColBERT runtime.
- `run-pipeline` uses the same host-aware default for ColBERT indexing unless `--rag-colbert-runtime` or `BESEDY_COLBERT_RUNTIME` overrides it.
- The legacy `isolated` runtime is no longer supported.

### Batch size

Both direct and pipeline builds expose `index_bsize` controls via `--index-bsize` / `--rag-colbert-index-bsize`. Benchmark-backed default is `index_bsize=32` for the canonical corpus/hardware pair; lower values (16, 8) reduced recall without lowering observed peak VRAM on the reference setup.

### Engine caveats (PyLate / FastPLAID)

Operational constraints that are not obvious from the code:

- **Periodic full rebuilds are required.** FastPLAID does not recompute
  centroids on incremental `add`/`remove`, so retrieval quality drifts as a
  bundle accumulates edits. Keep staged incremental sync as the outer loop but
  schedule periodic `--rebuild` passes. This is the motivation behind the
  Phase 5 maintenance rebuilds below.
- **Build and query run in separate runtimes.** Index build/mutation happens in
  a GPU container; query happens in a CPU container. FastPLAID segfaulted during
  index creation in a mixed CPU-only image; the clean GPU-build / CPU-query
  split is what works reliably.
- **Pin a concrete model revision.** The `jina-colbert-v2` remote-code path
  pulls floating Hugging Face files at startup. Production images should pin a
  model revision rather than rely on live remote-code updates.
- **FlashAttention-4 is not used; native attention only.** An FA4 spike
  (`beta7`) failed to run on the reference Blackwell / CUDA 12.8 / Torch 2.11 /
  Transformers 4.46 image: the kernel raised a `_trait` error on both the cu128
  image and a pip-resolved cu130 stack, the advertised `cu13` extra did not
  resolve from PyPI, and Transformers 4.46 still detects only the legacy FA2
  path (so ColBERT gets no FA4 hook regardless). Those versions describe that
  throwaway spike image, not the active serving stack. Revisit only as a
  separate experimental image, never by changing the active one.

### Services

The model-serving stack in `rag-services/docker-compose.yml` runs:

- `colbert` by default.
- TEI embeddings and reranker only behind the optional `legacy-tei` profile.

```bash
just rag-services-up   # default stack (ColBERT path)
just colbert-up
just colbert-logs
just tei-up            # optional legacy TEI services
just tei-down
```

## Incremental Sync

### Model

Incremental sync operates at the `audio_hash` level within a `(workflow_group_id, backend_key, colbert_model)` scope. The goal: add, refresh, and prune transcripts without rebuilding the entire scope on every change.

### source_state.sqlite

Bundle-local SQLite tracking one row per `audio_hash`:

| Column | Purpose |
| --- | --- |
| `audio_hash` (PK) | Transcript identity |
| `transcript_path` | Source file path |
| `transcript_fingerprint` | SHA-256 over canonical parsed transcript payload used for chunking |
| `chunking_fingerprint` | SHA-256 over normalized chunking config (chunk version, min/max tokens, overlap, token-counter identity) |
| `bundle_fingerprint` | SHA-256 over normalized index-wide ColBERT config (`colbert_model`, `doc_maxlen`, `use_faiss`, future build settings) |
| `chunk_count` | Number of chunks for this hash |
| `updated_at` | Last sync timestamp |
| `last_run_id` | Sync run identity |

This state lives inside the bundle because retrieval truth is bundle-local. PostgreSQL never holds sync state.

### Diff classification

Sync discovery runs in two layers:

1. **Scope discovery** -- find backend transcripts, map each to `audio_hash`, compute `transcript_fingerprint`.
2. **Sync classification** -- compare discovered hashes against `source_state.sqlite`, classify each as `added`, `changed`, `removed`, or `unchanged`.

If the computed `bundle_fingerprint` differs from the active bundle, targeted `--hash` refresh is not allowed and sync falls back to full rebuild.

### Mutation model

The update unit is one `audio_hash` (not individual chunks). When a transcript changes:

1. Rebuild all chunks for that hash.
2. Remove all existing chunks for that hash from the staging bundle.
3. Insert replacement chunks.

All mutations happen in a staging copy of the active bundle, never in the live bundle. The staging flow:

1. Resolve the active validated bundle.
2. Create a new timestamped staging bundle under the same model root.
3. Copy bundle artifacts into staging (`colbert_index/`, `chunk_store.sqlite`, `source_state.sqlite`, `index_meta.json`).
4. Apply per-hash removals and additions via worker `add-to-index` / `delete-from-index` commands.
5. Update `chunk_store.sqlite`, `source_state.sqlite`, `index_meta.json`, and `chunk_manifest.jsonl` in lockstep.
6. Validate the staged bundle.
7. Atomically repoint both the `index` symlink and `active_<model_slug>.json`.

If no active bundle exists, the first run bootstraps with a full build.

### Validation before cutover

Before pointer swap, the implementation validates:

- `colbert_index/` exists and is readable.
- `chunk_store.sqlite` exists and matches expected row counts.
- `source_state.sqlite` agrees with chunk-store counts per hash.
- `index_meta.json` matches the staged bundle.

Validation failure is a hard stop: neither the `index` symlink nor the active-pointer file is updated. The staging bundle is discarded.

Optional staged smoke-query validation is a follow-up hardening step, not required for the current path.

### Scope locking

One sync at a time per `(workflow_group_id, backend_key, colbert_model)`. A model-scope lock file under the bundle root protects bundle staging, pointer swap, and stale staging cleanup.

### CLI semantics

`rag-colbert-index` defaults to incremental per-`audio_hash` sync.

| Invocation | Behavior |
| --- | --- |
| (default) | Incremental full-scope sync: add new, refresh changed, prune removed |
| `--hash <sha256>` | Incremental targeted sync for one hash only |
| `--hash <sha256> --force` | Rebuild that hash even if unchanged |
| `--force` | Force-refresh all discovered hashes in scope |
| `--rebuild` | Discard incremental machinery, produce a fresh full bundle |

Sync output reports: hashes discovered, added, updated, removed, unchanged, failed; chunks inserted and deleted; sync mode (`incremental`, `forced`, or `rebuild`).

### Non-goals

- Reintroducing PostgreSQL tables (`rag_chunk`, `rag_source_state`).
- Chunk-level diffing inside one transcript.
- Mutating the currently active bundle in place.
- Changing the search route contract.

## Status

### Completed

| Phase | Scope |
| --- | --- |
| 1 | Bundle-local state and diff helpers (`source_state.sqlite`, per-hash fingerprinting, classification) |
| 2 | Staging-bundle mutation path (staging creation, chunk-store mutation, worker CRUD commands) |
| 3 | Incremental CLI semantics (`--hash`, `--force`, `--rebuild`, incremental default) |
| 4 | Validation, locking, and staging discard on failure |

### Pending

| Phase | Scope |
| --- | --- |
| 5 | Maintenance rebuilds and cleanup: rebuild thresholds / manual controls, stale bundle pruning, operational guidance |

Phase 5 is operational hardening. Core incremental sync is shipped and in use.
Periodic full rebuilds are the key Phase 5 concern -- see "Engine caveats
(PyLate / FastPLAID)" above for why they are required.
