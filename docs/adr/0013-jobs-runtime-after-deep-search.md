# ADR 0013: Jobs runtime after Deep Search removal

- **Status:** Proposed
- **Date:** 2026-11-06
- **Canonical references:** [Prefect jobs](../web/jobs-prefect.md), [system boundaries](0004-system-boundaries.md), [recording ingest](0008-web-recording-ingest.md)

## Context

Removing Deep Search leaves three flows: recording ingest, recording removal,
and correction indexing. They share one environment-specific host process pool,
with concurrency one by default. The jobs API, Prefect database, server and
services remain separate operational components. Maintaining and deploying
those components, their credentials and compatible versions has a cost.

A read-only production inspection on 2026-11-06 found three retained ingest runs
and no retained removal or correction-index runs in the production pool, with
no active or queued work. This is a snapshot of retained history, not a complete
usage history or a prediction of future demand. It supports reconsidering the
runtime's size; it does not establish that execution recovery is unnecessary.

The current host worker is a Prefect process worker. Replacing Prefect would
require a new consumer and recovery loop, even if the existing CLI commands and
domain callbacks were reused. Web intake and correction-publication records
describe business state; they are not execution leases.

## Proposed decision

Retain Prefect for the remaining flows now. Evaluate a PostgreSQL queue only as
a separate replacement of execution lifecycle management, with a measured
operational benefit and a recovery design before implementation. Do not retain
two authoritative queues or add queue state to every domain table.

Keep the authenticated jobs API boundary and validated identifier-only inputs.
The host worker must not gain general application-database write credentials
merely to simplify queue access. Reuse domain callbacks, catalog locks and
correction publication tokens regardless of the chosen execution runtime.

## Alternatives and obligations

| Concern | Retain the current runtime | Replace it with a database queue |
| --- | --- | --- |
| Submission | Existing deployment submission and idempotency keys | A durable job identity, unique submission key and authenticated claim API |
| Exclusive execution | Shared host pool and concurrency limit | Atomic claiming, bounded leases, heartbeat and fencing against stale workers |
| Worker death | Execution state, operator history and domain reconciliation | Detect abandoned claims; define retry limits, backoff and operator recovery |
| Repeated work | Existing CLI recovery and domain completion checks | Preserve those checks; lease expiry must not duplicate irreversible publication |
| Cancellation | Existing cancellation endpoint and worker lifecycle | Cancel queued claims and stop running child processes, then record partial results |
| Outcomes | Existing completion callbacks and intake/publication reconciliation | Retry lost callbacks and reconcile execution state with domain state |
| Maintenance | Existing idle checks and revision-pinned host deployment | Equivalent submission stop, drain checks and compatibility rules |
| Operation | Separate orchestration services and deployment coordination | Fewer services, but a new queue protocol, consumer and recovery surface to maintain |

Neither alternative makes filesystem work exactly once. A crash can occur after
an artifact is published and before completion is acknowledged. Recovery must
verify artifacts and domain tokens before resuming or retrying. Queue ownership
alone cannot replace catalog locking or publication validation.

## Evidence required to revisit

Record the remaining runtime's resource use, maintenance incidents and operator
time. Compare those costs with a small queue design covering the obligations
above and the existing status/history UI. A replacement should have a clear net
benefit for this workload, rather than merely fewer named services.

Before switching, demonstrate recovery from worker death, stale leases,
duplicate submissions, lost completion callbacks and cancellation during CLI
execution. Define an idle cutover with outstanding jobs accounted for and a
rollback path that cannot run the same job in both runtimes. These are design
criteria for a future proposal, not additional features to build now.

## Consequences

Deep Search removal reduces the jobs surface without coupling it to a queue
migration. Prefect's operational cost remains visible and can be measured. A
future queue replacement can reuse the existing domain operations while being
reviewed against explicit execution and recovery requirements.
