# ML Backends

> **Last Updated:** 2026-11-08

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
`backends/*/Dockerfile` and `requirements.lock`,
`rag-services/colbert/Dockerfile` and `requirements.lock`,
`rag-services/docker-compose.yml`, `web/package.json`).

### Locked Worker Images

The faster-whisper, NeMo, WhisperX, ARK-ASR, pyannote and ColBERT images are locked
so that a rebuild reproduces the image that produced the existing transcripts and
indexes. Each Dockerfile pins its base image by digest and installs its
`requirements.lock` (the image's `pip freeze --all`) with
`pip install --no-deps`, so pip installs exactly the locked versions.
Debian/Ubuntu packages from `apt-get` (for example ffmpeg) and the build tools
pip fetches for the few source-only packages are not locked. qwen3-asr is
experimental and not locked.

Upgrading an engine is a deliberate change: update the base image digest in
`FROM` if needed, install the new versions in a scratch container, regenerate
the lock from it with `pip freeze --all`, and compare transcripts from the old
and new images on a few fixed recordings before replacing the `:local` image.
Keep the lock's comment header and its `--extra-index-url` line: `pip freeze`
writes neither, and without the index the `+cu128` torch pins cannot install.
The header lists the image's top-level requirements to install.
For NeMo, uninstall `nvidia-resiliency-ext` before freezing; the comment in
`backends/nemo/Dockerfile` explains why the lock leaves it out.

---

## Model Serving Stack

The model-serving stack is independent of the web app stack and shared by dev,
test, and prod web environments on the same host.

### Service Table

| Container | Purpose | Endpoint | Profile |
|-----------|---------|----------|---------|
| `besedy-colbert` | Warm ColBERT query server (active retrieval path) | `http://127.0.0.1:8192` | default |

Requirements: NVIDIA GPU with CUDA, Docker with NVIDIA Container Toolkit
(`nvidia-ctk`), BuildKit/Buildx.

### ColBERT Sidecar Architecture

The `besedy-colbert` container keeps a persistent Python query server. Query
traffic goes to the warm in-container server, so repeated lookups against the
same sidecar index avoid reloading the model. One-off build and token-audit
jobs still use the worker script.

**Cold-load penalty.** The first query against a new sidecar index pays a
cold-load penalty while the server loads that index. Subsequent queries against
the same index stay warm until the container restarts or a different index is
requested.

**Preloading.** Set `COLBERT_PRELOAD_INDEX_DIR` to a sidecar index path inside
the container. If the path exists, the container loads it before marking the
service healthy. If it does not exist, the server logs a warning and continues
without a preloaded index; if it is empty, the server logs that no preload is
configured. The value lives in `~/.config/lukleh/besedy/rag-services.env` (or
the file `BESEDY_RAG_SERVICES_ENV` names; template `rag-services/.env.example`),
which every `just colbert-up` / `rag-services-up` passes to Compose through
`scripts/run_rag_services_compose.sh`, so recreating the container keeps it.
Use the wrapper (or the recipes) instead of raw `docker compose`; the file sets
the preload only, and the host path overrides stay shell variables because the
Python ColBERT runtime also calls Compose directly.
Point it at the `index` symlink
(`/data/state/rag_colbert/<wg_id>/<backend_slug>/<chunk_ver>/<model_slug>/index/colbert_index`),
not at an `index_<timestamp>/` folder: every index update, including the
incremental syncs, writes a new timestamped folder and moves the symlink, and
the server keys the loaded index by the resolved path, so a pinned timestamp
warms an old build and cold-loads the active one on the first search.

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

All three web environments reach ColBERT over the shared `besedy-internal`
network via `RAG_COLBERT_URL=http://besedy-colbert:8192/query`. The host port
binds `127.0.0.1` only; containers cannot reach host ports
([egress-isolation.md](web/egress-isolation.md)).

### Web Environment Integration

All three web environments (dev, test, prod) use the same shared ColBERT container.
The web container does not need filesystem access to bundles; the RAG services
stack resolves and serves them. Key env vars:

- `RAG_COLBERT_URL=http://besedy-colbert:8192/query`
- `RAG_COLBERT_ROOT_DIR=/data/state/rag_colbert` (the bundle root as the
  ColBERT container mounts it; the default when unset)
- `RAG_COLBERT_TIMEOUT_MS=8000` (timeout for each request to the sidecar)

### Retrieval Flow

```
Indexing                              Query
--------                              -----
Documents -> chunk -> ColBERT build   Query -> ColBERT sidecar /query
         -> bundle on disk                   -> bundle lookup / neighbors
                                             -> PostgreSQL ACL + metadata filter
                                             -> top snippets
```

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

Entries that omit `language` default to `"cs"` — the inference behavior every
workflow had before language became configurable. Automatic detection is always
an explicit opt-in.

For WhisperX with `language = "auto"`, omit `align_model`; WhisperX then chooses
an alignment model after detecting the language. A fixed language-specific
alignment model should only be paired with a matching explicit language;
requesting `auto` with a fixed aligner is rejected, at config load and at the
workflow CLI.

The configured language is also part of transcript identity: `auto` appends
`@lang-auto` to the workflow output component, and every concrete language
appends `@lang-<code>`. Czech (`cs`, explicit or defaulted) uses `@lang-cs`.
Unsuffixed Czech transcript trees from before September 2026 are no longer
written; to rename one, follow
[Renaming a transcript backend key](migrations/renaming-a-transcript-backend-key.md).
Canary translation runs with different source and target languages append
`@lang-<source>-<target>` so translations never collide with native
transcriptions.

### VAD (`[vad]`)

`min_silence_ms` controls segment splitting. Omit to use backend defaults.

| Use case | Range | Effect |
|----------|-------|--------|
| Rapid speech | 200--300 ms | More, shorter segments |
| Sparse dialogue | 800--1000 ms | Fewer, longer segments |

### Diarization speaker limits

`catalog diarize --pyannote-min-speakers` and `--pyannote-max-speakers` set
optional speaker-count bounds. Without these flags, pyannote estimates the
speaker count. The pipeline also leaves these bounds unset.

The retired `[diarization]` and `[analysis]` TOML sections are rejected; see
[Retired configuration cutover](web/operations.md#retired-configuration-cutover)
for the upgrade.

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
- Run every backend twice: once cold, once warm. The warm run proves cache
  reuse.

### Backend Matrix

Transcription: `faster-whisper`, `whisperx`, `qwen3-asr`, `nemo` (Canary greedy +
beam), `nemo-rnnt` (optional), and `ark-asr` (optional). Diarization: `pyannote`.

### Optional Unified and CzechSpeech candidates

`besedy.toml.example` includes two opt-in candidates with both
`pipeline_default = false` and `expected_default = false`. Normal pipeline runs
and expected-output checks do not include them; explicitly selecting a workflow
runs its configured variants. Keep the established RAG backend while comparing
these candidates: correction workspaces require the existing Faster Whisper
chunk/VAD contract, which a new RNNT transcript does not supply.

**Nemotron Labs Unified 0.6B:** configure `workflow_id = "nemo-rnnt"` with
`model = "nvidia/nemotron-labs-unified-asr-0.6b"`, `language = "cs"`, and
`vad_model = "silero_vad_v6"`. Build the separate worker:

```bash
docker compose -f backends/docker-compose.yml build nemo-rnnt
just catalog transcribe --workflow nemo-rnnt --hash <full_audio_hash>
```

This is an offline RNNT workflow with native word timestamps. It uses the NeMo
3.1 runtime rather than upgrading the existing Canary image. The tested source
checkpoint revision is `023ce907267a09a308a5cb69239447cb3d0c1597`; for a fixed run,
the `model` setting can also name that snapshot's local `.nemo` file. The model
publisher currently documents inference support. Separate partial fine-tuning
experiments do not reproduce its combined offline/streaming training recipe.
[Model card](https://huggingface.co/nvidia/nemotron-labs-unified-asr-0.6b)

**CzechSpeech:** use the original `moravianai/CzechSpeech` checkpoint, rather than
the throwaway fine-tuned smoke artifact. The tested revision is
`0762c5de1e8a2438f8e70f07c0d56beb27684ede`. Convert its downloaded HF snapshot
through the existing helper:

```bash
./backends/faster-whisper/convert_model.sh \
  --model /path/to/huggingface/snapshots/0762c5de1e8a2438f8e70f07c0d56beb27684ede \
  --output-dir /path/to/whisper_models/czechspeech-ct2
just catalog transcribe --workflow whisperx \
  --model /path/to/whisper_models/czechspeech-ct2 --hash <full_audio_hash>
```

Use the same path in the optional config entry, with
`align_model = "comodoro/wav2vec2-xls-r-300m-cs-250"`. CzechSpeech was trained
without timestamps; WhisperX supplies the existing Czech forced alignment.
Its weights are CC-BY-NC-4.0 for non-commercial use; commercial use needs a
separate license. Give each converted model a unique directory name, such as
`czechspeech-ct2`: local model identities use their directory basename.
[Model card](https://huggingface.co/moravianai/CzechSpeech)

### Optional ARK-ASR 0.6B candidate

The `ark-asr` entry in `besedy.toml.example` is excluded from both normal
pipeline runs and expected-output checks. Build its separate worker and the
existing alignment worker, then select it explicitly:

```bash
docker compose -f backends/docker-compose.yml build ark-asr whisperx
just catalog transcribe --workflow ark-asr --hash <full_audio_hash>
```

The model is `Edge0/ARK-ASR-0.6B`, with weights and custom model code pinned to
`45776b56d58cdfb2e2eb632f7e110f38684633e0`. This is a separate Transformers
runtime rather than an upgrade to the existing Whisper, Qwen, or NeMo images.
The checkpoint supplies text, without native word timestamps. Silero splits a
full recording into bounded speech chunks; a second WhisperX worker supplies
word alignment using `comodoro/wav2vec2-xls-r-300m-cs-250`.

Decoding has a fixed 512-token budget per chunk. A chunk that reaches that limit
without finishing aborts the file; capped text is not published. The raw bundle
is written atomically only after the whole file succeeds, and failed ASR blocks
the alignment stage.

This integration remains experimental. A real Czech recording produced
repetition loops, and short-slice diagnostics produced unexpected English text.
The complete pipeline run did not finish successfully. Keep it opt-in for
evaluation; these results do not justify promoting it to a default or claiming
reliable Czech quality.

`language = "cs"` chooses the transcript path and the Czech forced aligner.
It does not force the ARK decoder's language: the decoder detects language
automatically. A concrete language and an explicit `align_model` are required;
`language = "auto"` cannot select a fixed-language aligner safely.

The first stage writes atomic `ark_segments.json` bundles. Only successful
alignment writes canonical `transcript.json`. A normal retry validates and reuses
completed raw ASR before running missing alignment, without loading ARK weights
again; `--overwrite` reruns both stages. Model/code
revision, decoder-language behavior, chunk/VAD provenance, and alignment model
are carried into the canonical metadata. Artifacts retain the full audio hash
and the model/VAD/aligner/language output identity.
Alignment runs only after its ARK stage succeeds, so failed retranscription
cannot publish an old raw bundle as a new completed transcript.

This adds an inference experiment. It does not establish a supervised
fine-tuning recipe or change the correction and search defaults. The publisher's
training work uses teacher-based on-policy distillation; a smaller adaptation
needs separate validation.
[Pinned model card](https://huggingface.co/Edge0/ARK-ASR-0.6B/blob/45776b56d58cdfb2e2eb632f7e110f38684633e0/README.md)

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
2. **Preload and restart.** Make sure `COLBERT_PRELOAD_INDEX_DIR` in the
   rag-services env file points at the production `index/colbert_index`
   symlink. Recreate the ColBERT container so the preferred index is warm
   before the service marks itself healthy.
3. **Deploy web.** Rebuild and restart the production web container.

```bash
# 1) Check the preload (the container path of the `index` symlink)
grep COLBERT_PRELOAD_INDEX_DIR ~/.config/lukleh/besedy/rag-services.env

# 2) Recreate ColBERT
bash scripts/run_rag_services_compose.sh up -d --build --force-recreate colbert

# 3) Rebuild web
just prod-rebuild
```

### Rollout Verification

```bash
curl -s http://localhost:3000/api/version | jq          # web revision
curl -fsS http://127.0.0.1:8192/health | jq             # ColBERT healthy
curl -fsS http://127.0.0.1:8192/resolve \
  -H 'Content-Type: application/json' \
  -d '{"workflow_group_id":"<wg_id>","backend_key":"<bk>","colbert_model":"jinaai/jina-colbert-v2","root_dir":"/data/state/rag_colbert"}' | jq
```

### Rollback

Point `COLBERT_PRELOAD_INDEX_DIR` in the rag-services env file at the previous
known-good bundle (a concrete `index_<timestamp>/colbert_index` path, since the
`index` symlink follows the newest build) and recreate ColBERT. Put the symlink
path back afterwards. Then rebuild the web container if needed.

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

---

## Troubleshooting

**Container exits with "compute cap not compatible":** GPU architecture
mismatch. Check `nvidia-smi` and ensure the image supports your compute
capability.

**Model download stalls:** Check network inside the container. Delete the
model cache volume to force re-download:
`docker volume rm besedy_colbert_model_cache`

**ColBERT CLI says Docker service not running:** Start with
`just colbert-up`. For
index builds, ensure the `colbert-indexer` profile is available. Remove any
leftover `BESEDY_COLBERT_RUNTIME=isolated` -- that value is no longer supported.

**Output files owned by root:** Besedy launches workers with the calling
UID:GID. If ownership is wrong, check whether you ran a raw `docker run`
outside the Besedy runtime layer.
