# ML Backends

> **Last Updated:** 2026-04-04

How Besedy's ML backends are deployed and configured.

---

## Runtime Model

All ML backends run through Docker. Host-managed virtual environments under
`external/*-env/.venv/` are not part of the supported runtime model.

Layout:

- The main `.venv/` runs Besedy itself and lightweight shared dependencies.
- `just setup` keeps that host environment lean by default.
- Use `just setup-ml` when you need optional host-side workflow, speaker, or
  RAG helper modules.
- Use `just setup-jobs` when you need host-side Prefect jobs tooling.
- Transcription and diarization workers run through Docker.
- Host cache paths stay persistent even though worker containers are ephemeral.

Containers are launched by the CLI with per-invocation bind mounts,
`BESEDY_CONFIG` propagation, persistent cache mounts, and the calling UID/GID.

Dependency versions live in build files (`pyproject.toml`, `uv.lock`,
`backends/docker-compose.yml`, `rag-services/docker-compose.yml`,
`web/package.json`).

---

## Model Serving Stack

The model-serving stack is independent of the web app stack and shared by dev,
test, and prod web environments on the same host.

### Service Table

| Container | Purpose | Endpoint | Profile |
|-----------|---------|----------|---------|
| `besedy-colbert` | Warm ColBERT query server (active retrieval path) | `http://127.0.0.1:8192` | default |
| `besedy-tei-embeddings` | Dense embeddings (legacy evaluation flows) | `http://127.0.0.1:8190` | `legacy-tei` |
| `besedy-tei-reranker` | Reranking (optional for ColBERT path) | `http://127.0.0.1:8191` | `legacy-tei` |

Requirements: NVIDIA GPU with CUDA, Docker with NVIDIA Container Toolkit
(`nvidia-ctk`), BuildKit/Buildx (for TEI image build).

### ColBERT Sidecar Architecture

The `besedy-colbert` container keeps a persistent Python query server. Query
traffic goes to the warm in-container server, so repeated lookups against the
same sidecar index avoid reloading the model. One-off build and token-audit
jobs still use the worker script.

**Cold-load penalty.** The first query against a new sidecar index pays a
cold-load penalty while the server loads that index. Subsequent queries against
the same index stay warm until the container restarts or a different index is
requested.

**Preloading.** Set `COLBERT_PRELOAD_INDEX_DIR` to a sidecar index path. If the
path exists, the container loads it before marking the service healthy. If it
does not exist, the server logs a warning and continues without a preloaded
index.

**GPU indexing.** The `colbert-indexer` profile provides an ephemeral GPU build
worker, separate from the long-lived CPU query server. Both share Hugging Face
and Torch cache volumes. The indexer fixes bundle ownership back to the host
user after each run.

```
colbert          long-lived CPU query server (default profile)
colbert-indexer  ephemeral GPU build worker  (colbert-indexer profile)
```

The `rag-colbert-index` command defaults to the GPU Docker `colbert-indexer`
runtime on GPU hosts and to the CPU `docker` runtime on CPU-only hosts. The
live Docker query service always stays on CPU. Use `--runtime docker` to force
the CPU Docker path for a direct index build.

`index_bsize=32` is the benchmark-backed default. Lowering to 16 or 8 reduced
recall and did not lower observed peak VRAM on the reference machine.

**Health check:**

```bash
curl -fsS http://127.0.0.1:8192/health
```

**Bundle resolution.** The web route asks the ColBERT sidecar to resolve the
active validated bundle from `RAG_COLBERT_ROOT_DIR`. Required artifacts per
bundle:

- `colbert_index/`
- `index_meta.json`
- `chunk_store.sqlite`

ColBERT mode does not require the TEI reranker unless
`RAG_COLBERT_RERANK_ENABLED=true` is explicitly set. All three web environments
reach ColBERT via `RAG_COLBERT_URL=http://host.docker.internal:8192/query`.

### TEI Services (Optional)

TEI embeddings and reranking are behind the `legacy-tei` Docker Compose profile.
They are only needed for optional ColBERT reranking and older evaluation flows.

**Blackwell GPU (RTX 5070 Ti / 5090).** The compose stack builds a local TEI
image from upstream source (`Dockerfile-cuda-blackwell`). Blackwell support (TEI
PR #735) landed after v1.8.3, so `main` is required. Set
`TEI_BUILD_CONTEXT=...#v1.8.3` for strict release pinning on older GPUs.

**Health checks:**

```bash
curl -fsS http://127.0.0.1:8190/health   # embeddings
curl -fsS http://127.0.0.1:8191/health   # reranker
```

### Web Environment Integration

All three web environments (dev, test, prod) use the same host-level services.
The web container does not need filesystem access to bundles; the RAG services
stack resolves and serves them. Key env vars:

- `RAG_COLBERT_URL=http://host.docker.internal:8192/query`
- `RAG_COLBERT_ROOT_DIR=/workspace/besedy/tmp/rag_colbert`
- `RAG_COLBERT_RERANK_ENABLED=false` (set `true` to enable TEI reranker)

### Retrieval Flow

```
Indexing                              Query
--------                              -----
Documents -> chunk -> ColBERT build   Query -> ColBERT sidecar /query
         -> bundle on disk                   -> bundle lookup / neighbors
                                             -> PostgreSQL ACL + metadata filter
                                             -> optional POST /rerank
                                             -> top snippets
```

---

## Historical Enhanced-Audio Artifacts

Older installations may contain `audio_enhanced_*`, `audio_listen_*`,
`audio_asr_*`, or `transcripts_enhanced_*` artifacts. They remain ordinary
on-disk data, and transcript-path readers still recognize the historical
`transcripts_enhanced_*` naming convention. Besedy no longer ships an
enhanced-audio generation workflow or its DeepFilterNet and Resemble Enhance
images.

---

## Config Tuning

The full config key reference lives in `besedy.toml.example` and the
`besedy/config/settings.py` dataclass. This section covers the tuning-sensitive
parameters.

### Transcription Language

Each `[[transcription_workflows]]` entry has its own `language`, an ISO 639
code. Use `"auto"` for faster-whisper, WhisperX, and Qwen3-ASR to request
backend language detection. Canary requires a concrete prompt language such as
`"cs"`. Qwen3-ASR expects full language names ("Czech"); the workflow derives
them from the configured code at the inference boundary.

Entries that omit `language` default to `"cs"` — the behavior every workflow
had before language became configurable — so legacy configs keep their
behavior and output paths. Automatic detection is always an explicit opt-in.

For WhisperX with `language = "auto"`, omit `align_model`; WhisperX then chooses
an alignment model after detecting the language. A fixed language-specific
alignment model should only be paired with a matching explicit language;
requesting `auto` with a fixed aligner is rejected, at config load and at the
workflow CLI.

The configured language is also part of transcript identity: `auto` appends
`@lang-auto` to the workflow output component, and an explicitly non-Czech
language appends `@lang-<code>`. Czech (`cs`, explicit or defaulted) keeps the
historical path without a suffix so existing Czech transcripts remain reusable.
Canary translation runs with different source and target languages append
`@lang-<source>-<target>` so translations never collide with native
transcriptions.

### VAD (`[vad]`)

`min_silence_ms` controls segment splitting. Omit to use backend defaults.

| Use case | Range | Effect |
|----------|-------|--------|
| Rapid speech | 200--300 ms | More, shorter segments |
| Sparse dialogue | 800--1000 ms | Fewer, longer segments |

### Diarization (`[diarization]`)

`spectral_p_value` controls speaker separation aggressiveness (default: 0.22).

| Range | Behavior |
|-------|----------|
| 0.1--0.15 | Aggressive separation, may over-segment |
| 0.22 | Balanced, works for 2--4 speakers |
| 0.3--0.5 | Conservative, may under-segment |

### ColBERT Indexing

`index_bsize=32` is the benchmark-backed default. Do not lower without
per-host benchmarks showing a benefit.

### Audio

`sample_rate` must be 16000. All transcription backends require 16 kHz mono
WAV input. Changing this requires re-staging all audio.

---

## Verification

E2E verification proves the Docker runtime works on a real recording with real
artifacts, real caches, and host-resolvable paths.

### Principles

- Use the main CLI, not backend worker scripts directly.
- Use a scratch config (`cp besedy.toml /tmp/besedy-docker-e2e.toml`) and
  scratch output roots.
- Use a directory containing exactly one real speech recording.
- Docker is the default runtime; do not set `BESEDY_*_RUNTIME=docker`.
- Run every backend twice: once cold, once warm. The warm run proves cache
  reuse.

### Backend Matrix

Transcription: `faster-whisper`, `whisperx`, `qwen3-asr`, `nemo` (greedy +
beam). Diarization: `pyannote`.

### Artifact Checks

**Transcription:**

- `transcript.json` exists under the configured transcripts root.
- `meta.backend` matches the backend that ran.
- `meta.audio_filepath` is a real host path, not a container-only `/workspace/...`.
- File owner is the calling user, not `root`.

**Diarization:**

- `speakers.json` exists.
- `audio_file` is a real host path.
- File owner is the calling user.

### Minimum Pass Criteria

A backend is verified only if all of the following are true:

1. The real CLI command succeeds.
2. The expected output artifact exists.
3. Persisted metadata contains host-resolvable paths.
4. Outputs are not root-owned.
5. The warm rerun succeeds.
6. The warm rerun reuses caches (no fresh downloads).

### Cache Expectations

All model and runtime caches must persist across runs (HF, Torch, non-HF
artifacts). If a backend redownloads on the warm rerun, treat it as a Docker
runtime bug.

---

## Production Rollout

### ColBERT Rollout Sequence

Three steps, in this order:

1. **Build the bundle.** Ensure a complete ColBERT bundle exists for the
   production catalog/backend (index, metadata, chunk store).
2. **Preload and restart.** Set `COLBERT_PRELOAD_INDEX_DIR` to the production
   index path. Recreate the ColBERT container so the preferred index is warm
   before the service marks itself healthy.
3. **Deploy web.** Rebuild and restart the production web container.

```bash
# 1) Set preload
export COLBERT_PRELOAD_INDEX_DIR=/workspace/besedy/tmp/rag_colbert/<wg_id>/<backend_slug>/<chunk_ver>/<model_slug>/index/colbert_index

# 2) Recreate ColBERT
docker compose -f rag-services/docker-compose.yml up -d --build --force-recreate colbert

# 3) Rebuild web
just prod-rebuild
```

### Rollout Verification

```bash
curl -s http://localhost:3000/api/version | jq          # web revision
curl -fsS http://127.0.0.1:8192/health | jq             # ColBERT healthy
curl -fsS http://127.0.0.1:8192/resolve \
  -H 'Content-Type: application/json' \
  -d '{"workflow_group_id":"<wg_id>","backend_key":"<bk>","colbert_model":"jinaai/jina-colbert-v2","root_dir":"/workspace/besedy/tmp/rag_colbert"}' | jq
```

### Rollback

Point `COLBERT_PRELOAD_INDEX_DIR` at the previous known-good bundle and restart
ColBERT. Then rebuild the web container if needed.

### Index Rebuild Triggers

Rebuild the sidecar index when any of these change:

- ColBERT model
- Chunking settings
- Tokenizer or runtime configuration

```bash
just catalog rag-colbert-index \
  --group <workflow_group_id> \
  --backend <workflow>/<model_component> \
  --rebuild
```

TEI changes do not require a production RAG rebuild unless you are running legacy
evaluation flows.

---

## Troubleshooting

**Container exits with "compute cap not compatible":** GPU architecture
mismatch. Check `nvidia-smi` and ensure the image supports your compute
capability. See the Blackwell build note above.

**Model download stalls:** Check network inside the container. Delete the
model cache volume to force re-download:
`docker volume rm besedy_tei_model_cache besedy_colbert_model_cache`

**ColBERT CLI says Docker service not running:** Start with
`docker compose -f rag-services/docker-compose.yml up -d --build colbert`. For
index builds, ensure the `colbert-indexer` profile is available. Remove any
leftover `BESEDY_COLBERT_RUNTIME=isolated` -- that value is no longer supported.

**Output files owned by root:** Besedy launches workers with the calling
UID:GID. If ownership is wrong, check whether you ran a raw `docker run`
outside the Besedy runtime layer.
