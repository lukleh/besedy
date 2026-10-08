# New Host Bootstrap

> **Last Updated:** 2026-10-08

The order of one-time steps that turn a fresh Linux host into a working Besedy
deployment: production web, Deep Search jobs, ColBERT search, the GPU
backends, and admin upload ingest. Each step links to the section that owns
the details; this page adds what those sections assume. It was last walked
end to end on Ubuntu 24.04 with an RTX 5070 Ti, starting from `git clone`.

## Sizing

| Resource | Needed | Notes |
| --- | --- | --- |
| GPU | NVIDIA, CUDA 12.8 capable | No CPU path for transcription or diarization. The default pipeline peaked at about 10 GB VRAM on a 16 GB card. |
| Docker disk | about 250 GB free | Measured in one run: five backend images of 12-15 GB each and the 29 GB ColBERT image; the build cache roughly doubled that while building. |
| Model cache | about 10 GB | `HF_HOME` (default `~/.cache/huggingface`) after the default pipeline's first run. |
| RAM | 24 GB was enough | For the whole stack plus one pipeline run. |

## Order

1. **Host tools.** Docker Engine with Compose v2 and BuildKit, `just`, `uv`,
   `jq`, `git`, `ffmpeg`/`ffprobe`, Node.js 24 with npm
   ([README prerequisites](../README.md#prerequisites),
   [first deployment, step 1](web/operations.md#first-deployment-on-a-new-host)).
2. **GPU host.** See [GPU Host Prerequisites](#gpu-host-prerequisites) below.
3. **Clone and set up the host CLI:** `just setup-all`. The pipeline chunks
   transcripts for the ColBERT index on the host, which needs the `ml` extra
   that the lean `just setup` leaves out.
4. **`besedy.toml`:** copy `besedy.toml.example` to
   `~/.config/lukleh/besedy/besedy.toml` and set absolute `text_data_dir`,
   `audio_artifacts_dir`, `uploads_dir`, and `corrections_dir`
   ([README configuration](../README.md#configuration),
   [ingest paths](web/recording-ingest.md#paths-and-configuration)). Create the
   uploads and corrections directories owned by the group you will set as
   `UPLOADS_GID` in step 7, with mode `2770`
   ([first deployment, step 3](web/operations.md#first-deployment-on-a-new-host)).
5. **Models and backend images.** Accept the conditions of the gated pyannote
   models and export `HF_TOKEN` (or run `hf auth login`)
   ([README backend requirements](../README.md#requirements)); without it the
   pipeline stops at diarization. `run-pipeline` builds a missing backend
   image on first use, and on a GPU host its ColBERT index step builds the
   ColBERT image too. To build the backend images up front (about 11 minutes
   in the test run):
   `docker compose -f backends/docker-compose.yml build faster-whisper whisperx qwen3-asr nemo pyannote`.
   On its first run WhisperX fetches its Silero VAD from GitHub; when that
   download stalls, clone it into the torch.hub cache (path for the default
   `TORCH_HOME`):
   `git clone --depth 1 https://github.com/snakers4/silero-vad.git ~/.cache/torch/hub/snakers4_silero-vad_master`.
6. **First catalog.** See [First Catalog](#first-catalog) below.
7. **Production web:** [First Deployment on a New Host](web/operations.md#first-deployment-on-a-new-host).
   `AUTH_URL` must be an `https://` URL (see the
   [preflight checklist](web/operations.md#deploy-preflight-checklist)); over
   plain `http://` every sign-in ends signed out without an error.
8. **Prefect and the production jobs runtime:**
   [Deep Search deploy order](web/operations.md#deploy-order), steps 2 and 3.
   `just prefect-up` also needs `~/.config/lukleh/besedy/jobs.env.prefect`,
   copied from `jobs-service/.env.prefect.example`. `just jobs-prod-deploy`
   registers both the deep-search and the ingest work pools.
9. **ColBERT query server:** `just colbert-up`. Optionally set
   `COLBERT_PRELOAD_INDEX_DIR` in `~/.config/lukleh/besedy/rag-services.env`
   (template `rag-services/.env.example`) so it loads the index before it
   reports healthy; without it the first search loads the index
   ([ColBERT sidecar](backends.md#colbert-sidecar-architecture)).
10. **Host ingest worker:** [Host worker](web/recording-ingest.md#host-worker),
    with `HF_TOKEN` in `ingest-worker.env`.
11. **Egress policy:** [Installing on a Host](web/egress-isolation.md#installing-on-a-host).
    On a fresh host the recipes already create the `br-bsdy*` networks, so only
    the policy install (step 3 there) and the check remain.

## GPU Host Prerequisites

The backend and ColBERT images use CUDA 12.8 builds, so the host needs NVIDIA
driver 570 or newer; Blackwell cards (RTX 50 series) need the open kernel
modules. On Ubuntu:

```bash
sudo ubuntu-drivers list --gpgpu              # pick a current <version>-open driver
sudo ubuntu-drivers install --gpgpu nvidia:<version>-open
sudo apt-get install -y nvidia-utils-<version>
sudo reboot                                   # the driver can pull a newer kernel
```

Then install the NVIDIA Container Toolkit with apt as
[NVIDIA's install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
describes, register it with Docker, and check that a container sees the GPU:

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker run --rm --gpus all ubuntu:24.04 nvidia-smi -L
```

Without the toolkit, a backend run fails with
`failed to discover GPU vendor from CDI: no known GPU vendor found`.

## First Catalog

Admin uploads go into an existing catalog (the worker fails an upload whose
catalog CSV is missing with `catalog_missing`), and `catalog create` creates
nothing for a directory without audio, so bootstrap the first catalog from a
directory that holds at least one recording. Its first pipeline run also
builds the images and downloads the models (step 5):

```bash
just catalog create /path/to/recordings
just catalog run-pipeline
```

After production web is up, add it under **Admin -> Catalogs**, which lists the
catalogs under `<TEXT_DATA_DIR>/catalogs` that are not registered yet. Later
recordings can arrive through `/admin/ingest`.

## Acceptance Checklist

| Check | Command or action | Expected |
| --- | --- | --- |
| GPU in containers | `docker run --rm --gpus all ubuntu:24.04 nvidia-smi -L` | lists the GPU |
| Production env | `just env-check prod` | Compose accepts the env file |
| Production web | `curl -s http://localhost:3000/api/health` | `"status":"ok"` (a degraded status also answers 200) |
| Work pools | Prefect UI, or `POST http://127.0.0.1:4200/api/work_pools/filter` | `besedy-deep-search-prod` and `besedy-ingest-prod` |
| ColBERT | `curl -s http://127.0.0.1:8192/health` | `"ready": true` (the server answers; search proves the index) |
| Ingest worker | `systemctl --user is-active besedy-ingest-worker` | `active`, and an online worker on `besedy-ingest-prod` |
| Egress | `just egress-check` | `Egress check: OK` |
| Pipeline | `just catalog run-pipeline` | `All steps completed successfully!` |
| Upload | a short recording on `/admin/ingest` | `SUCCEEDED` with a hash link |
| Duplicate | the same file again | `REJECTED` (`duplicate`) |
| Search | a phrase from the new recording's transcript | the recording among the top results |
| Reboot | reboot the host, then repeat the web, ColBERT, worker, and egress checks | all pass without manual steps |
