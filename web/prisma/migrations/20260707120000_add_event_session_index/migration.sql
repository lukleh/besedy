-- Allow multiple distinct event sessions at the same catalog/location/date.
-- Recording-level audio_metadata.part remains reserved for split recordings.

ALTER TABLE "catalog_event"
ADD COLUMN "session_index" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "catalog_event"
ADD CONSTRAINT "catalog_event_session_index_check" CHECK ("session_index" >= 1);

DROP INDEX "catalog_event_identity_idx";

CREATE UNIQUE INDEX "catalog_event_identity_idx" ON "catalog_event" (
  "workflow_group_id",
  "location_id",
  "date_year",
  COALESCE("date_month", 0),
  COALESCE("date_day", 0),
  "session_index"
);
