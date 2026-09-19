-- Scope recorder, location and album lookups to one catalog.
--
-- These three tables were global and keyed by a unique name, while everything
-- referencing them is catalog-scoped: audio_metadata through workflow_group_id,
-- and catalog_event through location_id. That mismatch let an editor on any one
-- catalog edit rows every catalog depends on, and made a catalog's pickers offer
-- every value any catalog ever used. See docs/adr/0007-per-catalog-lookups.md.
--
-- Each catalog gets a copy of exactly the rows referenced from it. Rows nothing
-- references are parked in the default catalog rather than dropped, so a name
-- somebody typed is never silently lost. Original rows keep their identifiers,
-- because MCP hands lookup ids to clients; only the additional catalogs get new
-- rows.
--
-- Against production this degenerates to a backfill: there is one catalog, so
-- every row is assigned to it, nothing is duplicated and no id changes. The
-- duplication below is what keeps the migration correct once a second catalog
-- exists.

-- 1. Add the column, nullable for the length of the backfill.
ALTER TABLE "recorders" ADD COLUMN "workflow_group_id" VARCHAR(15);
ALTER TABLE "locations" ADD COLUMN "workflow_group_id" VARCHAR(15);
ALTER TABLE "albums" ADD COLUMN "workflow_group_id" VARCHAR(15);

-- 2. Keep each original row and give it the lowest catalog that references it,
--    so existing identifiers stay resolvable for whoever remembered them.
UPDATE "recorders" r
SET "workflow_group_id" = (
  SELECT MIN(m."workflow_group_id")
  FROM "audio_metadata" m
  WHERE m."recorder_id" = r."id"
);

UPDATE "locations" l
SET "workflow_group_id" = (
  SELECT MIN(source."workflow_group_id") FROM (
    SELECT m."workflow_group_id" FROM "audio_metadata" m WHERE m."location_id" = l."id"
    UNION ALL
    SELECT e."workflow_group_id" FROM "catalog_event" e WHERE e."location_id" = l."id"
  ) AS source
);

UPDATE "albums" a
SET "workflow_group_id" = (
  SELECT MIN(m."workflow_group_id")
  FROM "audio_metadata" m
  WHERE m."album_id" = a."id"
);

-- 3. Park unreferenced rows in the active default catalog, falling back to the
--    oldest active catalog. If rows need parking but no active catalog exists,
--    fail here with an actionable error instead of reaching an opaque NOT NULL
--    violation later in the migration.
DO $$
DECLARE
  parking_catalog_id VARCHAR(15);
BEGIN
  SELECT "id"
  INTO parking_catalog_id
  FROM "workflow_group"
  WHERE "is_active" = true
  ORDER BY "is_default" DESC, "id"
  LIMIT 1;

  IF EXISTS (SELECT 1 FROM "recorders" WHERE "workflow_group_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "locations" WHERE "workflow_group_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "albums" WHERE "workflow_group_id" IS NULL)
  THEN
    IF parking_catalog_id IS NULL THEN
      RAISE EXCEPTION
        'Cannot scope metadata lookups: unreferenced lookup rows exist but no active catalog is available';
    END IF;

    UPDATE "recorders"
    SET "workflow_group_id" = parking_catalog_id
    WHERE "workflow_group_id" IS NULL;

    UPDATE "locations"
    SET "workflow_group_id" = parking_catalog_id
    WHERE "workflow_group_id" IS NULL;

    UPDATE "albums"
    SET "workflow_group_id" = parking_catalog_id
    WHERE "workflow_group_id" IS NULL;
  END IF;
END $$;

-- 4. Retire the global uniqueness on name before copying, or the copies would
--    collide with the rows they are copied from.
DROP INDEX "recorders_name_key";
DROP INDEX "locations_name_key";
DROP INDEX "albums_name_key";

-- 5. Copy each row into every further catalog that references it. Names were
--    globally unique until now, so (catalog, name) identifies a copy uniquely.
INSERT INTO "recorders" ("workflow_group_id", "name", "created_at", "updated_at")
SELECT DISTINCT m."workflow_group_id", r."name", r."created_at", r."updated_at"
FROM "audio_metadata" m
JOIN "recorders" r ON r."id" = m."recorder_id"
WHERE m."workflow_group_id" <> r."workflow_group_id";

INSERT INTO "locations" ("workflow_group_id", "name", "created_at", "updated_at")
SELECT DISTINCT source."workflow_group_id", l."name", l."created_at", l."updated_at"
FROM (
  SELECT m."workflow_group_id", m."location_id" FROM "audio_metadata" m WHERE m."location_id" IS NOT NULL
  UNION
  SELECT e."workflow_group_id", e."location_id" FROM "catalog_event" e WHERE e."location_id" IS NOT NULL
) AS source
JOIN "locations" l ON l."id" = source."location_id"
WHERE source."workflow_group_id" <> l."workflow_group_id";

INSERT INTO "albums" ("workflow_group_id", "name", "created_at", "updated_at")
SELECT DISTINCT m."workflow_group_id", a."name", a."created_at", a."updated_at"
FROM "audio_metadata" m
JOIN "albums" a ON a."id" = m."album_id"
WHERE m."workflow_group_id" <> a."workflow_group_id";

-- 6. Point every reference at the copy that lives in its own catalog.
UPDATE "audio_metadata" m
SET "recorder_id" = copy."id"
FROM "recorders" original, "recorders" copy
WHERE m."recorder_id" = original."id"
  AND copy."name" = original."name"
  AND copy."workflow_group_id" = m."workflow_group_id"
  AND copy."id" <> original."id";

UPDATE "audio_metadata" m
SET "location_id" = copy."id"
FROM "locations" original, "locations" copy
WHERE m."location_id" = original."id"
  AND copy."name" = original."name"
  AND copy."workflow_group_id" = m."workflow_group_id"
  AND copy."id" <> original."id";

UPDATE "catalog_event" e
SET "location_id" = copy."id"
FROM "locations" original, "locations" copy
WHERE e."location_id" = original."id"
  AND copy."name" = original."name"
  AND copy."workflow_group_id" = e."workflow_group_id"
  AND copy."id" <> original."id";

UPDATE "audio_metadata" m
SET "album_id" = copy."id"
FROM "albums" original, "albums" copy
WHERE m."album_id" = original."id"
  AND copy."name" = original."name"
  AND copy."workflow_group_id" = m."workflow_group_id"
  AND copy."id" <> original."id";

-- 7. Every row now has a catalog, so the column can carry the constraint.
ALTER TABLE "recorders" ALTER COLUMN "workflow_group_id" SET NOT NULL;
ALTER TABLE "locations" ALTER COLUMN "workflow_group_id" SET NOT NULL;
ALTER TABLE "albums" ALTER COLUMN "workflow_group_id" SET NOT NULL;

-- 8. A name is unique within a catalog rather than across all of them.
CREATE UNIQUE INDEX "recorders_workflow_group_id_name_key" ON "recorders"("workflow_group_id", "name");
CREATE UNIQUE INDEX "locations_workflow_group_id_name_key" ON "locations"("workflow_group_id", "name");
CREATE UNIQUE INDEX "albums_workflow_group_id_name_key" ON "albums"("workflow_group_id", "name");

CREATE INDEX "recorders_workflow_group_id_idx" ON "recorders"("workflow_group_id");
CREATE INDEX "locations_workflow_group_id_idx" ON "locations"("workflow_group_id");
CREATE INDEX "albums_workflow_group_id_idx" ON "albums"("workflow_group_id");

ALTER TABLE "recorders" ADD CONSTRAINT "recorders_workflow_group_id_fkey"
  FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "locations" ADD CONSTRAINT "locations_workflow_group_id_fkey"
  FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "albums" ADD CONSTRAINT "albums_workflow_group_id_fkey"
  FOREIGN KEY ("workflow_group_id") REFERENCES "workflow_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
