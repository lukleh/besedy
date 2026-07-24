-- Create albums table (enum for album names)
CREATE TABLE "albums" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "albums_pkey" PRIMARY KEY ("id")
);

-- Add unique constraint on name
CREATE UNIQUE INDEX "albums_name_key" ON "albums"("name");

-- Add album_id column to audio_metadata
ALTER TABLE "audio_metadata" ADD COLUMN "album_id" INTEGER;

-- Migrate data: insert unique album names from existing album string field
INSERT INTO "albums" ("name", "updated_at")
SELECT DISTINCT "album", CURRENT_TIMESTAMP
FROM "audio_metadata"
WHERE "album" IS NOT NULL AND "album" != '';

-- Link existing records to album IDs based on matching album name
UPDATE "audio_metadata" am
SET "album_id" = a."id"
FROM "albums" a
WHERE am."album" = a."name";

-- Add foreign key constraint
ALTER TABLE "audio_metadata"
ADD CONSTRAINT "audio_metadata_album_id_fkey"
FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Create index on album_id
CREATE INDEX "audio_metadata_album_id_idx" ON "audio_metadata"("album_id");

-- Drop old album string column
ALTER TABLE "audio_metadata" DROP COLUMN "album";
