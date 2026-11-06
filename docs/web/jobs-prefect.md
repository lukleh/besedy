# Prefect Jobs Runtime

> **Status:** Adopted

The jobs runtime queues recording ingestion, recording removal, and correction
index updates outside the web application. Python and host Docker/GPU access
remain in the host worker. Prefect owns run scheduling, retries, cancellation,
concurrency and operator history; Besedy owns the domain requests and outcomes.

## Runtime boundaries

- `web` authenticates users, checks catalog permissions and submits validated
  operations to its environment's jobs API.
- `jobs-api` validates the service bearer token and domain payload, submits
  deployment runs, and projects their state into Besedy JSON. Production runs
  immutable packaged code as a non-root user with a read-only root filesystem.
  It has no host data, configuration or credential bind mounts.
- Shared `prefect-postgres`, `prefect-server` and `prefect-services` retain the
  orchestration state. Their API/UI stay on the trusted internal/loopback boundary.
- The host `besedy-ingest-worker` process polls one environment-specific work
  pool and runs the catalog CLI with the operator's Docker/GPU access. Host
  configuration and the callback secret stay in its own environment file.

There is no general-purpose report-generation worker or language-model provider
runtime in the jobs stack. Research clients use the read-only [MCP server](mcp-server.md).

[ADR 0013](../adr/0013-jobs-runtime-after-deep-search.md) proposes retaining this
runtime while measuring its operating cost and the recovery work a database
queue would require.

## Remaining deployments

`just jobs-<dev|test|prod>-deploy` registers all three deployments on the same
`PREFECT_INGEST_WORK_POOL`, with `PREFECT_INGEST_CONCURRENCY_LIMIT` (default 1):

| Flow | Default production deployment | Kind |
| --- | --- | --- |
| `ingest_recording_flow` | `ingest_recording_flow/ingest-prod` | `INGEST` |
| `remove_recording_flow` | `remove_recording_flow/ingest-remove-prod` | `INGEST` |
| `sync_correction_index_flow` | `sync_correction_index_flow/correction-index-prod` | `CORRECTION_INDEX` |

Development and test use their own `-dev` and `-test` suffixes. The API reads
`PREFECT_INGEST_FULL_DEPLOYMENT_NAME`,
`PREFECT_INGEST_REMOVE_FULL_DEPLOYMENT_NAME`, and
`PREFECT_CORRECTION_INDEX_FULL_DEPLOYMENT_NAME`. The deployment helper also reads
the corresponding short deployment names and shared pool/concurrency settings.
The flow-run UUID remains the job identity; Besedy does not add queue tables,
leases or a second job ID.

## API and callback responsibilities

- `POST /catalogs/:id/ingest/jobs` submits an upload intake.
- `POST /catalogs/:id/ingest/removals` submits a catalog-scoped removal.
- `POST /catalogs/:id/correction/index-sync/jobs` submits publication, rollback
  or search-withdrawal indexing.
- `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/history` and
  `POST /jobs/:id/cancel` inspect or control supported runs.
- The worker reports outcomes to the existing internal ingest/correction web
  callbacks. The web database remains authoritative for intake and publication
  state; Prefect records execution state.

All non-health API requests require `BESEDY_JOB_SERVICE_SECRET`, matching the
web and host-worker configuration. User authorization stays in the web routes.
Unknown historical job kinds are not exposed as current ingest jobs.

## Configuration and operation

Copy the appropriate `jobs-service/.env.<mode>.example` outside the checkout.
The shared control plane uses `.env.prefect.example`; the host worker uses
`host-worker/ingest-worker.env.example`. The API image requires only the locked
`jobs` extra; the host worker also installs `ml` for the existing pipeline.

The Compose wrapper validates project/container identity and pool/deployment
suffixes before resource-changing commands. Stopping and inspecting a miswired
stack remains possible. Each web environment calls its own explicitly named
jobs API container on `besedy-internal`; only Prefect is shared.

`just jobs-prod-check-idle` checks every scheduled, pending, running, paused or
cancelling run on the production ingest pool. Coordinated deployment checks
before downtime and again after web/API submissions stop. A busy pool refuses
maintenance; wait or cancel explicitly. Host-worker deployment keeps its own
idle checks and revision-pinned checkout.

See [operations.md](operations.md#jobs-production-runtime) for deployment,
retirement and recovery, and [recording-ingest.md](recording-ingest.md#host-worker)
for host-worker installation and configuration.
