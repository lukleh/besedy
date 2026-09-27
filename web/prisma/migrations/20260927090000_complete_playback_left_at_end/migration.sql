-- Positions saved within 1.5 s of the end are finished listens, matching
-- isAtPlaybackEnd() in src/lib/playback-progress.ts. Rows imported from
-- browser-only storage by older clients kept them unfinished, so event lists
-- showed 99% for recordings that had been heard to the end.
UPDATE "recording_playback_progress"
SET "completed_at" = "updated_at"
WHERE "completed_at" IS NULL
  AND "duration_sec" > 0
  AND "position_sec" > 0
  AND "position_sec" >= "duration_sec" - 1.5;
