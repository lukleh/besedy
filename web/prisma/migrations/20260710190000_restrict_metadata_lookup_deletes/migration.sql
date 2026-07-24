-- Lookup values are shared across catalogs. Deleting one while it is being
-- assigned must fail instead of silently clearing the new metadata reference.
ALTER TABLE "audio_metadata"
DROP CONSTRAINT "audio_metadata_recorder_id_fkey",
ADD CONSTRAINT "audio_metadata_recorder_id_fkey"
  FOREIGN KEY ("recorder_id") REFERENCES "recorders"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audio_metadata"
DROP CONSTRAINT "audio_metadata_location_id_fkey",
ADD CONSTRAINT "audio_metadata_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audio_metadata"
DROP CONSTRAINT "audio_metadata_album_id_fkey",
ADD CONSTRAINT "audio_metadata_album_id_fkey"
  FOREIGN KEY ("album_id") REFERENCES "albums"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
