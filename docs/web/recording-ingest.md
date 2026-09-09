# Recording Ingest (Admin Upload)

> **Last Updated:** 2026-09-08
> **Status:** Phase 1 - upload, process, auto-sync, status. Metadata/event
> pre-fill is a follow-up.

Admins upload recordings on **Admin -> Ingest** (`/admin/ingest`). The web app
stores the file, submits an `INGEST` job to the jobs API, and a Prefect worker
running on the host executes the normal CLI pipeline. When the run finishes the
worker reports back and the web app re-syncs the catalog projection, so the
recording appears without a manual "Sync catalog" click.

Decision record: [ADR 0005](../adr/0005-web-recording-ingest.md).

## Flow

```
admin browser ── chunked PUTs ──▶ web  POST /api/admin/ingest/uploads
                                        PUT  /api/admin/ingest/uploads/:id/chunks/:n
                                        POST /api/admin/ingest/uploads/:id/finalize
        recording_intake row: UPLOADING ─▶ QUEUED
        web ──▶ jobs-api POST /catalogs/:catalog/ingest/jobs ──▶ Prefect flow run

host worker (work pool besedy-ingest-<env>, concurrency 1)
  ingest_recording_flow(catalog_id, intake_id, original_filename)
    1. find <uploads>/<catalog>/incoming/<intake>/source.<ext>
    2. audio hash (decoded PCM)  ── already in audio_catalog_<catalog>.csv?
         yes ─▶ move to <uploads>/<catalog>/rejected/<intake>/  ─▶ REJECTED/duplicate
         no  ─▶ move to <uploads>/<catalog>/accepted/<intake>/<name>.<ext> (+ .audiohash)
    3. python -m besedy.cli.catalog add <uploads>/<catalog>/accepted/<intake> --csv <csv> --no-symlink
    4. python -m besedy.cli.catalog run-pipeline --csv <csv> --no-symlink
    5. POST web /api/internal/ingest/<intake>/complete {status, audioHash, errorCode}
       (if this cannot be delivered the run fails with a message carrying the
        outcome as `completion_report_failed:{...}` and the web app applies it later)

web complete route: update recording_intake; on SUCCEEDED run syncCatalogGroup()
UI: polls GET /api/admin/ingest while rows are QUEUED/RUNNING; those rows are
    reconciled against jobs-api GET /jobs/:id (status-guarded writes) so crashed,
    cancelled and callback-less runs end, and undelivered outcomes are applied.
```

Only `catalog_id` and `intake_id` travel from the web app to the worker; both
are validated tokens and every path is derived from the worker's own
`besedy.toml`. The web container and the host see the uploads root under
different paths (`/data/uploads` vs. the host directory), which is why no path
is ever passed across.

## Paths and configuration

| Where | Setting | Value |
| --- | --- | --- |
| Host `besedy.toml` (worker + CLI) | `[paths].uploads_dir` | host directory, e.g. `/mnt/data/besedy_uploads` |
| Web env file (`web.env.<mode>`) | `UPLOADS_DIR` | the same host directory; mounted rw at `/data/uploads` |
| Web env file | `BESEDY_PATH_MAPPINGS` | must include `<host uploads dir>=/data/uploads` because catalog rows point at the host path |
| Web container toml (`web/besedy.docker.toml`) | `[paths].uploads_dir` | `/data/uploads` |
| Web env file (optional) | `INGEST_CHUNK_BYTES` | default 50 MB; keep below the edge proxy body limit (Cloudflare: 100 MB) and Next's `experimental.proxyClientMaxBodySize` (100mb in `web/next.config.ts`) |
| Web env file (optional) | `INGEST_MAX_UPLOAD_BYTES` | default 4 GB |
| jobs env (`jobs.env.<env>`) | `PREFECT_INGEST_WORK_POOL`, `PREFECT_INGEST_DEPLOYMENT_NAME`, `PREFECT_INGEST_FULL_DEPLOYMENT_NAME`, `PREFECT_INGEST_CONCURRENCY_LIMIT` | defaults `besedy-ingest-<env>`, `ingest-<env>`, `ingest_recording_flow/ingest-<env>`, `1` |

The uploads root must be writable by the web container user (UID 1001 in
production) **and** by the host worker user. Every directory level the web app
creates below it is chmod'ed to `0777` explicitly (the umask would otherwise mask
`mkdir`'s mode), because the worker - a different UID - has to move files out of
`incoming/<intake>/` and create `accepted/` and `rejected/` next to it.

Layout on disk:

```
<uploads_dir>/
  <catalog_id>/
    incoming/<intake_id>/source.mp3      # while uploading / queued
    accepted/<intake_id>/<name>.mp3      # permanent; catalog Full Path, dir = Scan Root
    accepted/<intake_id>/<name>.mp3.audiohash
    rejected/<intake_id>/source.mp3      # duplicates, kept for inspection
```

Each intake gets its own `accepted/<intake_id>/` directory, and that directory
is what `catalog add` scans (and records as `Scan Root`): exactly one file per
run, so earlier uploads are never re-hashed and a file left behind by a run that
failed after the move can never be picked up by a later ingest. Both CLI calls
use `--no-symlink` so the operator's `audio_catalog*`,
`audio_staged` and `transcripts` "latest" symlinks are never re-pointed by a
background job.

## Host worker

The flow needs the operator's Docker daemon, GPU backends, `ffmpeg` and the host
`besedy.toml`, so the worker runs on the host, not in the hardened jobs
containers. Source files:

- `jobs-service/host-worker/besedy-ingest-worker.service` - systemd user unit
- `jobs-service/host-worker/ingest-worker.env.example` - required environment
- `besedy/lib/prefect_jobs/flows/ingest_recording.py` - the flow

Install (once per host):

```bash
cp jobs-service/host-worker/ingest-worker.env.example ~/.config/lukleh/besedy/ingest-worker.env
# fill in PREFECT_INGEST_WORK_POOL, BESEDY_INTERNAL_BASE_URL, BESEDY_JOB_SERVICE_SECRET,
# BESEDY_CONFIG, RAG_BACKEND_KEY, HF_TOKEN, PATH
mkdir -p ~/.config/systemd/user
cp jobs-service/host-worker/besedy-ingest-worker.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now besedy-ingest-worker
loginctl enable-linger "$USER"
journalctl --user -u besedy-ingest-worker -f
```

The unit assumes the checkout lives at `~/projects/besedy`; adjust
`WorkingDirectory` otherwise. For development run it in the foreground with
`just ingest-worker-run` (defaults to pool `besedy-ingest-dev`).

Register the pool and deployment together with deep search:

```bash
just jobs-dev-deploy    # or jobs-test-deploy / jobs-prod-deploy
```

`BESEDY_JOB_SERVICE_SECRET` must match the web environment the worker reports
to (`BESEDY_INTERNAL_BASE_URL`, `http://127.0.0.1:3000` for production web).

Security note: the worker runs with the operator's privileges. It accepts only
`catalog_id` (`YYYYMMDD_HHMMSS`) and `intake_id` (lowercase alphanumeric) from
the web app, sanitises the display filename, and never interpolates input into a
shell (argv lists only).

## Statuses and error codes

| Status | Meaning |
| --- | --- |
| `UPLOADING` | chunks still arriving; `DELETE /api/admin/ingest/uploads/:id` aborts |
| `QUEUED` | job created in Prefect, worker has not started |
| `RUNNING` | flow running (`prefectStateName` shows the Prefect state) |
| `SUCCEEDED` | catalog updated and projection re-synced; `audioHash` links to the recording |
| `REJECTED` | `duplicate` - same decoded audio already in the catalog; `audioHash` is the existing recording |
| `FAILED` | see `errorCode` |
| `CANCELLED` | cancelled in the Prefect UI |
| `REMOVING` | removal flow running on the host worker |
| `REMOVED` | recording and all derived data deleted (row kept for the audit trail) |

Error codes: `submit_failed` (the jobs API rejected the submit with a 4xx;
file removed), `undecodable_audio`, `intake_missing`, `intake_invalid`,
`catalog_missing`, `accepted_exists`, `catalog_add_failed`,
`run_pipeline_failed`, `ingest_failed` (unexpected), `worker_failed` /
`worker_cancelled` (terminal Prefect state without a completion report),
`job_missing`, `completion_missing` (Prefect finished but no report arrived; the
catalog was re-synced), `sync_failed` (ingest succeeded but the projection sync
failed - click **Sync catalog**).

If the jobs API is unreachable or misconfigured at finalize, the row stays
`UPLOADING` with the file kept and the page shows **Retry submit**. If the
worker cannot deliver its final report (web down during the retry window), the
run fails with `completion_report_failed:{...}` in its message and the next
admin poll applies that outcome and syncs the catalog.

## Operations

- Do not run `just catalog run-pipeline` by hand on a catalog while an ingest
  for it is RUNNING; the flow holds a per-catalog lock only against other
  ingest flows, not against the operator shell.
- After a `FAILED` or `CANCELLED` ingest run `just catalog check` for that
  catalog: a run killed mid-transcription can leave a truncated
  `transcript.json` that later runs treat as complete.
- `run-pipeline` processes every pending row of the catalog, so an ingest can
  also finish work left over from manual runs. This is intentional.
- Production preflight adds: `UPLOADS_DIR` + `BESEDY_PATH_MAPPINGS` in the web
  env file, `uploads_dir` in the host toml, the `PREFECT_INGEST_*` entries in
  `jobs.env.prod`, `just jobs-prod-deploy`, and the running host worker unit.

## Removing an ingested recording

Every row on **Admin -> Ingest** in a finished state has a **Remove** action
(confirm dialog). Two cases:

- The recording reached the catalog (`SUCCEEDED`, or `FAILED` after the file
  was accepted): the row becomes `REMOVING` and the host worker runs
  `remove_recording_flow` (`besedy/lib/prefect_jobs/flows/remove_recording.py`):
  `catalog remove --hash <hash> --execute --delete-source` (drops the hash from
  `audio_catalog_<TS>.csv` and its `_loudness`, `_loudness_normalized`,
  `_loudness_archived`, `_duplicates` and `_joined` generations, deletes the
  source file + `.audiohash`, the staged WAV, the archived audio, every
  `transcripts/<backend>/<model>/<hash>/`, `speaker_diarization/*/<hash>/` and
  `speaker_embeddings/*/file/<hash>/`), then `catalog run-pipeline --no-symlink`
  so the incremental ColBERT sync prunes the hash from the chunk store, FTS and
  PLAID index (no rebuild; the query server reloads on the next query) and
  `cluster-speakers` rebuilds without it, then removes the intake directories
  and reports `REMOVED`. The web app deletes the recording's event assignment
  (unreleasing an event that loses its primary recording), curated metadata,
  playback progress and notifications, and re-syncs the projection.
- The recording never reached the catalog (`REJECTED` duplicate, early failure,
  `CANCELLED`): only the upload files are deleted and the row becomes `REMOVED`
  immediately. A rejected intake's hash belongs to the *existing* recording it
  duplicated, which is never touched.

`catalog remove` is also usable by hand (dry run without `--execute`); CSV rows
are dropped only after every artifact deletion succeeded, and the rewrites are
atomic. A failed removal run shows `remove_failed` and keeps the hash so it can
be retried; `derived_refresh_failed` means the recording is gone but the
`run-pipeline` refresh failed - run it manually.

## Follow-ups (phase 2)

- Collect title/date/location/recorder/event on upload and apply them once the
  hash is known (metadata upsert + `catalog-events/from-recording`).
- Cancel from the web UI (needs process-group signalling verified end-to-end).
- Scope `run-pipeline` to the uploaded hash instead of all pending rows.
