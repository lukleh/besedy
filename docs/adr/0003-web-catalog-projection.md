# ADR 0003: Web catalog serving projection

- **Status:** Accepted
- **Date:** 2026-07-15
- **Canonical reference:** [Web data and database](../web/data-and-database.md#catalog-data-model)

## Context

The Python pipeline naturally publishes portable catalog CSVs and filesystem
artifacts. Interactive web access additionally needs indexed filtering,
authorization, curated metadata, event relationships, and transactional writes.
Parsing CSVs independently in API routes would produce inconsistent request
latency and duplicate join logic.

## Decision

Pipeline catalog CSVs are ingest sources. A synchronization boundary
materializes their joined serving representation in PostgreSQL. Normal API
requests query PostgreSQL and never parse catalog CSVs directly. Transcript,
audio, poster, and source payloads remain filesystem artifacts referenced only
through server-controlled paths.

The projection is replaceable derived data; user-authored relational state and
audit data are authoritative PostgreSQL records and must not be reconstructed
from CSVs.

## Consequences

- Synchronization needs an explicit source-generation, locking, failure, and
  freshness contract.
- The web app may continue serving the last successful projection when a refresh
  fails, but operators must be able to observe that state.
- Catalog schema evolution must update both the Python producer contract and the
  synchronization parser.
- API clients never supply arbitrary filesystem paths.
