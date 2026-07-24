# Prefect-Based Jobs Plan

> **Last Updated:** 2026-04-09
> **Status:** Adopted

This document is the preferred implementation path. It replaces an earlier design that used a bespoke PostgreSQL queue/lease/worker substrate.

The deep-search product boundary stays the same. The orchestration substrate changes from a bespoke PostgreSQL queue to self-hosted Prefect.

External Prefect capabilities in this document were checked against official Prefect docs on 2026-04-09. Re-check the current docs before implementation if this sits for long.

## Goal

Keep the existing Besedy deep-search intent:

- async deep-search execution outside the Next.js app
- Python worker runtime for `rlmbenchy`
- typed Besedy-owned submit and inspection APIs
- job/result visibility through JSON APIs
- a separate execution boundary from the web app

But stop building custom orchestration primitives that Prefect already provides:

- deployment-backed flow runs
- workers and work pools
- retries
- cancellation
- concurrency controls
- run history and operator UI
- artifacts

## Decision Summary

Use Prefect as the orchestration control plane.

Keep a thin Besedy-owned API facade in front of Prefect.

For the active implementation:

- do not add custom `job_run` / `job_event` tables
- keep the Prefect-based facade as the only supported jobs runtime
- use Prefect flow runs as the canonical execution records
- use the Prefect flow run UUID as the Besedy job `id` for v1
- use Prefect artifacts plus a shared worker output directory for result materialization

## What Stays The Same

The following boundary points still hold, independent of the orchestration substrate:

- deep search is asynchronous
- deep search runs outside the Next.js app
- Besedy remains the domain source for retrieval, citation expansion, and metadata lookup
- Besedy owns the deep-search signature and retrieval tools; `rlmbenchy` provides the generic RLM runtime
- the worker runtime is Python-based
- the `jobs` extra declares `rlmbenchy` as a Git dependency pinned to an
  exact revision; Besedy's committed `uv.lock` resolves the complete runtime
- the public route shape stays typed and Besedy-owned
- product auth and per-user visibility rules are still deferred until the execution path is proven

## What Changes From the Earlier Plan

The old plan proposed:

- service-owned queue tables
- custom polling
- custom leases and heartbeats
- custom expired-lease recovery
- custom append-only job history

The Prefect plan replaces those pieces with Prefect-native concepts:

- `job_run` becomes a Prefect flow run
- `job_event` becomes a combination of Prefect run states, task runs, logs, and artifacts
- worker polling and claiming move into Prefect workers and work pools
- retries and cancellation move into Prefect orchestration
- operator inspection moves primarily to the Prefect UI

The Besedy-specific API facade stays because Prefect should not become the browser-facing or product-facing API boundary.

## Preferred Runtime Topology

For the first Prefect-based POC, use:

- `web`
- `jobs-api`
- `prefect-postgres`
- `prefect-server`
- `prefect-services`
- `prefect-worker`
- existing Besedy internal deep-search endpoints

Notes:

- Prefect's self-hosted guidance often shows PostgreSQL, server, background services, and worker as the core pieces, with Redis commonly added in fuller self-hosted stacks.
- For the first local POC spike, it is acceptable to start without Redis if the minimal server/services/worker path is sufficient.
- If we keep Prefect and need the fuller self-hosted stack later, reevaluate adding Redis explicitly.
- The default self-hosted stack has no auth by itself; keep the Prefect UI and API on a trusted internal boundary for the POC.

## Boundary And Responsibilities

### `web`

Responsibilities:

- submit deep-search jobs through Besedy-owned APIs
- list and inspect jobs through Besedy-owned APIs
- not call Prefect directly
- not own orchestration state

### `jobs-api`

Responsibilities:

- expose `POST /catalogs/:id/deep-search/jobs`
- expose `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/history`, `POST /jobs/:id/cancel`
- validate Besedy-specific payloads
- create and inspect Prefect deployment runs
- normalize Prefect data into Besedy job JSON
- own future auth and visibility rules

### `prefect-server` and `prefect-services`

Responsibilities:

- store deployment and flow-run orchestration state
- coordinate flow runs, states, retries, and artifacts
- provide operator UI and API

### `prefect-worker`

Responsibilities:

- listen on the deep-search work pool
- execute deployed deep-search flow runs
- expose Prefect-native logs, task states, and artifacts
- host the Python environment required for `rlmbenchy`

### Besedy internal deep-search endpoints

Responsibilities:

- own retrieval logic
- own citation expansion
- own recording metadata lookup
- remain the only source of Besedy domain truth for those actions

## Prefect Model Mapping

Use the following model for the first implementation:

- one Prefect flow: `deep_search_flow`
- one deployment: `deep-search-default`
- one work pool: `besedy-deep-search`
- one worker type for v1: `process`

Use a `process` work pool first because:

- the flow runs in the same locked image environment as the worker
- the only persistent writable mount it needs is the result-bundle output root
- this keeps the first spike simpler than introducing containerized per-run infrastructure immediately

Once the packaging boundary is cleaner, reevaluate a Docker work pool.

## Canonical Job Identity

For v1, the canonical Besedy job `id` should be the Prefect flow run UUID.

That means:

- `POST /catalogs/:id/deep-search/jobs` returns the created flow run ID as `id`
- `GET /jobs/:id` reads that flow run directly
- `POST /jobs/:id/cancel` cancels that flow run directly

Do not add a second Besedy-generated job ID unless a concrete product requirement appears.

## Flow Run Parameters

The deployment run should accept parameters equivalent to the current deep-search job payload:

```json
{
  "catalog_id": "catalog-123",
  "query": "what did they say about ...",
  "requested_by_id": "admin-1",
  "caller_scope": "admin-1",
  "retrieval": {
    "top_k": 200,
    "include_neighbors": true,
    "neighbor_count": 1,
    "window": {
      "neighbor_count": 1
    },
    "lm_profile": null,
    "sub_lm_profile": null
  },
  "execution": {}
}
```

Keep the external submit body smaller:

```json
{
  "query": "...",
  "topK": 200,
  "lmProfile": null,
  "subLmProfile": null,
  "requestedById": "admin-1"
}
```

Reject legacy `bundleKey` requests with HTTP `400` and an explicit migration message instead of silently defaulting to the worker's pinned profiles.

The `jobs-api` layer should enrich that external payload into deployment-run parameters.

## Flow Run Metadata

When creating the deployment run, set:

- a custom flow-run name
- tags for filtering and debugging
- an optional idempotency key if the submitter provides one later

Suggested flow-run name:

- `deep-search-{catalog_id}-{short_hash_or_timestamp}`

Suggested tags:

- `job-kind:deep-search`
- `catalog:{catalog_id}`
- `requested-by:{requested_by_id}`
- `caller-scope:{caller_scope}`

Use sanitized tag values only.

## Besedy API Surface

The Besedy route shapes should stay close to the current plan.

### `POST /catalogs/:id/deep-search/jobs`

Responsibilities:

- validate the request body
- build Prefect deployment parameters
- trigger a deployment-backed flow run
- return a normalized job summary

Implementation notes:

- create deployment runs programmatically rather than requiring UI clicks
- return immediately after the flow run is created
- use deployment-backed runs so cancellation and retry behave correctly

### `GET /jobs`

Responsibilities:

- list flow runs relevant to Besedy jobs
- support filters such as `kind`, `catalogId`, `requestedById`, `limit`
- translate Prefect state into Besedy job summaries

Use Prefect flow-run filters plus run tags to implement this.

### `GET /jobs/:id`

Responsibilities:

- return normalized flow-run status
- include important artifact references
- include final result preview when present
- include the final markdown and structured JSON if already materialized

### `GET /jobs/:id/history`

For the POC, do not rebuild a custom append-only `job_event` model.

Instead, return a normalized history view composed from:

- flow-run state transitions
- task-run summaries
- artifact metadata
- optionally a link to the Prefect UI run page

The Prefect UI should be the primary operator debugging surface. The Besedy JSON history endpoint is a convenience layer, not a second orchestration system.

### `POST /jobs/:id/cancel`

Cancel the Prefect flow run.

Important requirement:

- cancellation only works properly for deployment-backed runs
- a Prefect monitoring process must be running to enforce cancellation

## State Mapping

Expose a stable Besedy job shape while preserving Prefect detail.

Suggested external mapping:

| Prefect state | Besedy status |
| --- | --- |
| `Scheduled`, `Pending`, `Late` | `QUEUED` |
| `Running`, `Cancelling`, `Paused` | `RUNNING` |
| `Completed` | `SUCCEEDED` |
| `Cancelled` | `CANCELLED` |
| `Failed`, `Crashed`, `TimedOut` | `FAILED` |

Also return:

- `prefectStateName`
- `prefectStateType`
- `prefectFlowRunId`
- `prefectDeploymentId`

This keeps the external API stable while preserving operator detail.

## Result And Artifact Model

Use two storage layers:

1. Prefect artifacts for operator visibility
2. a shared worker output directory for durable job outputs

### Prefect artifacts

Use Prefect artifacts for:

- progress updates
- final markdown report
- a table artifact for the initial retrieval hit set
- a link artifact pointing to the output directory or the persisted result bundle

Suggested artifact keys:

- `deep-search-progress-{flow_run_id}`
- `deep-search-report-{flow_run_id}`
- `deep-search-initial-hits-{flow_run_id}`
- `deep-search-output-{flow_run_id}`

### Shared output directory

The worker should also write a per-run bundle to a mounted directory such as:

- `tmp/deep-search/{flow_run_id}/`

Suggested contents:

- `report.md`
- `result.json`
- `initial_hits.json`
- `followup_trace.json`
- `run_metadata.json`
- `worker.log` or log references

The `jobs-api` service can read from this directory when serving detail responses.

For the POC, a shared local volume is acceptable. If this graduates, move the output bundle to an object store.

## Flow Structure

The deep-search execution should become a Prefect flow with a small number of explicit tasks.

Suggested shape:

1. `validate_inputs`
2. `run_initial_retrieval`
3. `publish_initial_hit_artifacts`
4. `run_rlm_deep_search`
5. `persist_output_bundle`
6. `publish_final_artifacts`

Keep the flow coarse enough to be readable, but not so coarse that the entire job is one opaque function.

## Retry Policy

Do not blindly retry the whole deep-search flow.

For v1:

- use task-level retries for small Besedy HTTP calls
- use bounded retry counts with exponential backoff for retrieval/citation/metadata tasks
- do not automatically retry the full `rlmbenchy` task unless it is shown to be safe and idempotent

Suggested starting point:

- retrieval task: `retries=2`
- citation/metadata helper tasks: `retries=2`
- top-level flow: `retries=0`

Manual rerun through Prefect is acceptable for failed full runs during the POC.

## Concurrency Plan

Start with the simplest safe rule:

- deployment/work-pool/worker concurrency limit: `10`
- collision strategy: enqueue new runs

This keeps the POC open for parallel evaluation while avoiding unbounded worker fan-out.

Later, if the product requirement becomes "only one active deep-search job per effective caller scope", add a second layer:

- compute a sanitized concurrency key from `caller_scope`
- use Prefect global concurrency limits around the expensive execution region

Do not start with dynamic per-user concurrency objects in the first spike unless that constraint blocks evaluation.

## Secrets And Configuration

Use Prefect blocks only where they help. Do not move all config into Prefect prematurely.

### Keep as normal container env vars for v1

- `PREFECT_API_URL`
- `BESEDY_INTERNAL_BASE_URL`
- `OPENROUTER_API_KEY` (worker-only provider secret consumed by `rlmbenchy`; do not put it in submit payloads or Prefect parameters)
- `NVIDIA_API_KEY` (worker-only provider secret consumed by `rlmbenchy` when selected profiles use NVIDIA)
- `CODEX_CONTAINER_HOME` (worker-only Codex auth directory inside the container, default `/run/codex`; only needed for `model-chatgpt-*` profiles)
- `CODEX_HOST_AUTH_FILE` (ChatGPT-only overlay: host `auth.json` mounted read-only at `${CODEX_CONTAINER_HOME}/auth.json`; `rlmbenchy` treats Codex credentials as read-only, and the rest of the host Codex directory is not exposed; OpenRouter/NVIDIA workers have no Codex mount)
- `RLMBENCHY_LM_PROFILE` (main LM profile name or path; required unless the job payload provides `retrieval.lm_profile`)
- `RLMBENCHY_SUB_LM_PROFILE` (sub LM profile for `llm_query` calls; required unless the job payload provides `retrieval.sub_lm_profile`)
- `RLMBENCHY_ADAPTER_MODE` (default `auto`)
- `RLMBENCHY_SEED` (default `1`)
- `RLMBENCHY_REPL_BACKEND` (default `local`; the hardened production image does not expose the Docker daemon required by the `docker` backend)
- `DEEP_SEARCH_OUTPUT_DIR`
- worker log/output path settings

### Good candidates for Prefect `Secret` blocks

- `BESEDY_JOB_SERVICE_SECRET`
- any future third-party API secrets used by `rlmbenchy`

For the first POC, plain env vars are acceptable if the deployment stays internal. If the team expects to keep Prefect, move secrets into Prefect blocks early.

## Compose Plan

Replace the queue-specific compose stack with the split Prefect and runtime
compose files under [jobs-service](../../jobs-service/).

Suggested services:

- `prefect-postgres`
- `prefect-server`
- `prefect-services`
- `jobs-api`
- `prefect-worker`

For the first local spike, `prefect-redis` is optional. Start with the minimal runnable stack first, then add Redis if Prefect operational guidance or observed behavior makes it necessary.

Suggested image split:

- use the official `prefecthq/prefect:3-latest` image for `prefect-server` and `prefect-services`
- use a Besedy repo image for `jobs-api` and `prefect-worker`, with `prefect` and the packaged `rlmbenchy` distribution installed in the same environment as Besedy

The production runtime is image-only: it does not mount the Besedy checkout.
The Docker build installs Besedy and its revision-pinned `rlmbenchy` dependency
from the public Git repository over HTTPS according to the committed `uv.lock`.
Production containers run as a non-root UID/GID, use a read-only root filesystem
with a bounded `/tmp` tmpfs, drop all capabilities, and enable
`no-new-privileges`. Only the worker output directory is writable persistently;
`jobs-api` receives the same directory read-only.

For the first worker, mount only the persistent output volume (plus the Besedy
config file read-only). The production API sees output read-only; the worker
sees it read-write.

Do not mount the `rlmbenchy` checkout into the build or running worker. Update
the pinned Git revision and regenerate `uv.lock` when Besedy intentionally
adopts a newer `rlmbenchy` version.

## Deployment Registration Plan

Do not rely on manual setup in the Prefect UI.

Add a small registration script in the repo that:

- ensures the work pool exists
- ensures the deep-search deployment exists
- applies the initial deployment concurrency limit
- can be re-run safely

Prefer a committed Python registration script over ad hoc UI clicks.

Suggested command shape:

- `uv run python -m besedy.lib.prefect_jobs.deploy`

## Code Organization Plan

Add a new module tree instead of stretching the current custom queue implementation further.

Suggested layout:

- `besedy/lib/prefect_jobs/api.py`
- `besedy/lib/prefect_jobs/client.py`
- `besedy/lib/prefect_jobs/models.py`
- `besedy/lib/prefect_jobs/deploy.py`
- `besedy/lib/prefect_jobs/flows/deep_search.py`
- `besedy/lib/prefect_jobs/artifacts.py`

Reuse where sensible:

- keep the shared internal deep-search client in `besedy/lib/internal_deep_search_client.py`
- keep request validation in the Prefect-facing models/API layer
- keep the stub deep-search executor idea in the Prefect flow tests

The legacy `besedy/lib/jobs_service/` spike code has been retired from the active codebase.

## Minimal First Milestone

The smallest useful Prefect milestone is:

1. add `prefect` to the Python environment
2. stand up local self-hosted Prefect with server, services, worker, Postgres, and Redis
3. add one deployed stub deep-search flow
4. add a thin Besedy `jobs-api` facade that triggers deployment runs
5. implement `GET /jobs/:id` and `POST /jobs/:id/cancel`
6. return normalized Prefect-backed job summaries
7. verify cancellation, retry, and operator visibility in the Prefect UI

Only after that should the real Besedy retrieval and `rlmbenchy` path be wired in.

## Suggested Phase Plan

### Phase 1: Prefect scaffold

- add `prefect` dependency
- replace compose stack with Prefect services
- add worker and API images/config
- add deployment registration script
- add stub flow and one deployment

### Phase 2: Besedy API facade

- implement typed submit route
- implement list/detail/cancel endpoints backed by Prefect
- normalize Prefect states and metadata into Besedy job JSON
- expose Prefect UI link in debug responses

### Phase 3: real deep-search execution

- move the current stub executor shape into Prefect tasks
- call Besedy internal retrieval/citation/metadata APIs
- run `rlmbenchy`
- persist markdown and JSON outputs
- publish Prefect artifacts

### Phase 4: hardening

- refine retries and timeouts
- add bounded concurrency
- improve result bundle persistence
- add history endpoint normalization
- improve cancellation behavior for long RLM runs

### Phase 5: web integration

- point the deep-search page at the Besedy `jobs-api`
- add list/detail polling
- preserve Labs/admin gating decisions from the existing docs
- settle per-user visibility rules at the API facade boundary

## Testing Plan

For the first implementation, test three layers separately.

### Unit tests

- submit payload validation
- state mapping from Prefect to Besedy status
- artifact/result translation
- cancel/list/detail behavior with a mocked Prefect client

### Local integration tests

- bring up the Prefect stack with Docker Compose
- register the deep-search deployment
- submit a stub run through the Besedy API facade
- verify list/detail/cancel behavior
- verify the final markdown artifact appears in Prefect

### End-to-end deep-search validation

- run one real catalog-scoped deep-search query
- inspect initial retrieval artifact
- inspect final report artifact
- verify the output bundle on disk

## Open Questions

These questions do not block the first Prefect spike, but they should be tracked:

1. Should `jobs-api` remain a standalone Python service, or should the Next.js app eventually proxy the same logic?
2. Is the POC satisfied with the Prefect flow run UUID as the public job ID, or do we want a Besedy-generated wrapper ID later?
3. How much normalized history do we actually need in `GET /jobs/:id/history` if the Prefect UI is available to operators?
4. When should we move from a `process` work pool to a Docker work pool?
5. When should result bundles move from a shared volume to object storage?

## Short Version

Keep the Besedy deep-search API shape, but replace the custom queue, leasing, and worker lifecycle with self-hosted Prefect.

For v1:

- Besedy owns the typed HTTP contract
- Prefect owns orchestration state and workers
- Prefect flow runs are the canonical jobs
- Prefect artifacts plus a shared output volume hold results
- the first implementation uses a `process` work pool and one deep-search deployment

## Source Notes

Primary sources checked on 2026-04-09:

- Prefect self-hosted Docker Compose: <https://docs.prefect.io/v3/how-to-guides/self-hosted/docker-compose>
- Prefect deployments overview: <https://docs.prefect.io/v3/how-to-guides/deployments/create-deployments>
- Prefect deployment runs: <https://docs.prefect.io/v3/how-to-guides/deployments/run-deployments>
- Prefect deployment Python helpers: <https://docs.prefect.io/v3/api-ref/python/prefect-deployments-flow_runs>
- Prefect retries: <https://docs.prefect.io/v3/how-to-guides/workflows/retries>
- Prefect cancellation: <https://docs.prefect.io/v3/advanced/cancel-workflows>
- Prefect artifacts concept: <https://docs.prefect.io/v3/concepts/artifacts>
- Prefect artifact how-to: <https://docs.prefect.io/v3/develop/artifacts>
- Prefect blocks concept: <https://docs.prefect.io/v3/concepts/blocks>
- Prefect secrets guide: <https://docs.prefect.io/latest/guides/secrets/>
- Prefect global concurrency: <https://docs.prefect.io/v3/how-to-guides/workflows/global-concurrency-limits>
