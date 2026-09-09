# ADR 0005: Web-triggered recording ingest through a host Prefect worker

- **Status:** Accepted
- **Date:** 2026-09-08
- **Canonical reference:** [Recording ingest](../web/recording-ingest.md)

## Context

Adding a recording required the operator to copy a file onto the host, run
`catalog add` and `catalog run-pipeline`, and then re-sync the catalog in the
web app. The web app should be able to start that workflow from an admin page.

Three constraints shape the design:

- Transcription, diarization and ColBERT indexing run as GPU Docker containers
  launched by the CLI through the host Docker daemon. The hardened jobs
  containers ([ADR 0004](0004-system-boundaries.md)) have no Docker socket, no
  GPU and a read-only filesystem, so they cannot run ingestion.
- The web container mounts catalogs and audio read-only; uploads need a
  writable root that the Python side also sees.
- The recording identity (decoded-audio SHA-256, [ADR 0001](0001-audio-identity.md))
  only exists after the Python side decodes the file, so an upload must be
  tracked by its own id until the worker reports the hash.

## Decision

- Uploads land in a dedicated writable root, `[paths].uploads_dir`, laid out as
  `<catalog>/incoming/<intake>/`, `<catalog>/accepted/<intake>/` and
  `<catalog>/rejected/<intake>/`. Accepted files stay in their per-intake
  directory, which becomes their permanent catalog path and scan root, so a
  `catalog add` run touches exactly one file.
- The web app tracks each upload as a `recording_intake` row and submits an
  `INGEST` job to the existing Prefect jobs facade. The job is a Prefect flow
  (`ingest_recording_flow`) in its own work pool with concurrency 1.
- That pool is served by a **host-resident** Prefect process worker running as
  the operator, beside the hardened container worker for deep search. The flow
  shells out to the same CLI the operator runs by hand.
- The worker trusts only two validated tokens from the web app (`catalog_id`,
  `intake_id`) and derives every path from its own configuration; no filesystem
  paths cross the web/worker boundary ([ADR 0003](0003-web-catalog-projection.md)).
- A file whose decoded-audio hash already exists in the catalog is rejected and
  moved aside before `catalog add` runs, so duplicates never enter the catalog
  or its duplicates report.
- Removal is the mirror image: a hash-scoped `catalog remove` (CSV rows,
  source, staged/archived audio, transcripts, diarization, embeddings) followed
  by the normal pipeline pass, whose incremental ColBERT sync prunes the hash
  and whose clustering step rebuilds without it - no index rebuild. The web app
  then deletes its own rows for the hash and unreleases an event that loses its
  primary recording rather than leaving listeners an event without audio.
- The worker reports completion to an internal, bearer-authenticated web route,
  which updates the intake and re-syncs the catalog projection. The web app
  also reconciles queued/running intakes against Prefect so crashes surface.

## Consequences

- Production gains a process outside Docker that must be installed and kept
  running (systemd user unit) and that carries the operator's Docker access;
  its inputs are therefore restricted to validated identifiers.
- Uploads are chunked because the production edge caps request bodies well
  below typical recording sizes.
- The ingest and deep-search workers can still contend for the GPU; the pool
  limit only serialises ingests.
- `run-pipeline` processes every pending catalog row, not just the upload; that
  is idempotent and acceptable. A cancelled or crashed run can leave partial
  artifacts that `catalog check` must surface.
