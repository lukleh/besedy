-- ROLLING_BACK is committed before the filesystem pointer is restored, so it
-- must hold the same one-publication-at-a-time invariant as PENDING and
-- ACTIVATING. This migration follows the enum-value migration deliberately:
-- PostgreSQL must commit a new enum value before an index predicate may use it.

DROP INDEX "transcript_publication_in_flight_per_workspace_key";

CREATE UNIQUE INDEX "transcript_publication_in_flight_per_workspace_key"
ON "transcript_publication"("workspace_id")
WHERE "status" IN ('PENDING', 'ACTIVATING', 'ROLLING_BACK');
