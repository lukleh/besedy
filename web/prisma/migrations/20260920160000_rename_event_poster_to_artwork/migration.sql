-- Rename the event poster concept to artwork (English) / obálka (Czech).
-- Data-preserving throughout: tables, the column, the audit enum labels, and the
-- stored permission names are renamed in place. Nothing is dropped or recreated.
-- The filesystem rename (scripts/migrate-artwork-storage.ts) runs in the same
-- downtime window, before this migration.

-- 1. Audit enum. RENAME VALUE (PG10+) keeps every existing audit_log row valid and
--    preserves the label's sort position, so no row rewrite and no type swap.
ALTER TYPE "AuditAction" RENAME VALUE 'EVENT_POSTER_CREATED'     TO 'EVENT_ARTWORK_CREATED';
ALTER TYPE "AuditAction" RENAME VALUE 'EVENT_POSTER_DELETED'     TO 'EVENT_ARTWORK_DELETED';
ALTER TYPE "AuditAction" RENAME VALUE 'EVENT_POSTER_PUBLISHED'   TO 'EVENT_ARTWORK_PUBLISHED';
ALTER TYPE "AuditAction" RENAME VALUE 'EVENT_POSTER_UNPUBLISHED' TO 'EVENT_ARTWORK_UNPUBLISHED';

-- 2. Tables and the column. RENAME rewrites catalog entries only; the composite
--    FK and the indexes follow the column by attnum and are not rebuilt.
ALTER TABLE "catalog_event_poster"             RENAME TO "catalog_event_artwork";
ALTER TABLE "catalog_event_poster_publication" RENAME TO "catalog_event_artwork_publication";
ALTER TABLE "catalog_event_artwork_publication" RENAME COLUMN "poster_id" TO "artwork_id";

-- 3. Constraints and indexes. Postgres does not rename these with their table,
--    and Prisma compares their names, so a stale name is permanent schema drift.
ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_pkey" TO "catalog_event_artwork_pkey";
ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_square_bytes_check" TO "catalog_event_artwork_square_bytes_check";
ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_landscape_bytes_check" TO "catalog_event_artwork_landscape_bytes_check";
ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_square_sha256_check" TO "catalog_event_artwork_square_sha256_check";
ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_landscape_sha256_check" TO "catalog_event_artwork_landscape_sha256_check";
ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_event_id_workflow_group_id_fkey" TO "catalog_event_artwork_event_id_workflow_group_id_fkey";
ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_created_by_fkey" TO "catalog_event_artwork_created_by_fkey";

ALTER INDEX "catalog_event_poster_id_event_id_workflow_group_id_key"         RENAME TO "catalog_event_artwork_id_event_id_workflow_group_id_key";
ALTER INDEX "catalog_event_poster_workflow_group_id_event_id_created_at_idx" RENAME TO "catalog_event_artwork_workflow_group_id_event_id_created_at_idx";

-- Postgres 18 catalogues NOT NULL as a named constraint, generated from the
-- table name at CREATE TIME (this landed in 18, not 17 -- the feature was
-- reverted before 17.0 shipped); RENAME TABLE does not rename these, so they
-- are stale unless renamed explicitly. No app or Prisma-visible effect either
-- way, but left alone they are the last place "poster" survives in the
-- catalog. Guarded so this migration still completes on an older server
-- (dev laptop, restored dump, staging not yet on PG18) where these named
-- constraints don't exist -- renaming them there would otherwise abort the
-- whole transaction with "constraint ... does not exist".
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 180000 THEN
    ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_id_not_null" TO "catalog_event_artwork_id_not_null";
    ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_event_id_not_null" TO "catalog_event_artwork_event_id_not_null";
    ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_workflow_group_id_not_null" TO "catalog_event_artwork_workflow_group_id_not_null";
    ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_square_extension_not_null" TO "catalog_event_artwork_square_extension_not_null";
    ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_square_original_name_not_null" TO "catalog_event_artwork_square_original_name_not_null";
    ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_square_bytes_not_null" TO "catalog_event_artwork_square_bytes_not_null";
    ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_square_sha256_not_null" TO "catalog_event_artwork_square_sha256_not_null";
    ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_landscape_extension_not_null" TO "catalog_event_artwork_landscape_extension_not_null";
    ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_landscape_original_name_not_null" TO "catalog_event_artwork_landscape_original_name_not_null";
    ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_landscape_bytes_not_null" TO "catalog_event_artwork_landscape_bytes_not_null";
    ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_landscape_sha256_not_null" TO "catalog_event_artwork_landscape_sha256_not_null";
    ALTER TABLE "catalog_event_artwork" RENAME CONSTRAINT "catalog_event_poster_created_at_not_null" TO "catalog_event_artwork_created_at_not_null";
    ALTER TABLE "catalog_event_artwork_publication" RENAME CONSTRAINT "catalog_event_poster_publication_event_id_not_null" TO "catalog_event_artwork_publication_event_id_not_null";
    ALTER TABLE "catalog_event_artwork_publication" RENAME CONSTRAINT "catalog_event_poster_publication_workflow_group_id_not_null" TO "catalog_event_artwork_publication_workflow_group_id_not_null";
    ALTER TABLE "catalog_event_artwork_publication" RENAME CONSTRAINT "catalog_event_poster_publication_poster_id_not_null" TO "catalog_event_artwork_publication_artwork_id_not_null";
    ALTER TABLE "catalog_event_artwork_publication" RENAME CONSTRAINT "catalog_event_poster_publication_published_at_not_null" TO "catalog_event_artwork_publication_published_at_not_null";
  END IF;
END $$;

ALTER TABLE "catalog_event_artwork_publication" RENAME CONSTRAINT "catalog_event_poster_publication_pkey" TO "catalog_event_artwork_publication_pkey";
ALTER TABLE "catalog_event_artwork_publication" RENAME CONSTRAINT "catalog_event_poster_publication_event_id_workflow_group_i_fkey" TO "catalog_event_artwork_publication_event_fkey";
ALTER TABLE "catalog_event_artwork_publication" RENAME CONSTRAINT "catalog_event_poster_publication_poster_id_event_id_workfl_fkey" TO "catalog_event_artwork_publication_artwork_fkey";
ALTER TABLE "catalog_event_artwork_publication" RENAME CONSTRAINT "catalog_event_poster_publication_published_by_fkey" TO "catalog_event_artwork_publication_published_by_fkey";

ALTER INDEX "catalog_event_poster_publication_poster_id_key"                  RENAME TO "catalog_event_artwork_publication_artwork_id_key";
ALTER INDEX "catalog_event_poster_publication_event_id_workflow_group_id_key" RENAME TO "catalog_event_artwork_publication_event_catalog_key";
ALTER INDEX "catalog_event_poster_publication_poster_id_event_id_workflo_key" RENAME TO "catalog_event_artwork_publication_artwork_event_catalog_key";

-- 4. Stored permission names (text[] columns).
UPDATE "catalog_access" SET "extra_permissions" = array_replace(array_replace(
  "extra_permissions", 'manage_event_posters', 'manage_event_artwork'), 'publish_event_posters', 'publish_event_artwork')
WHERE "extra_permissions" && ARRAY['manage_event_posters','publish_event_posters']::text[];

UPDATE "pending_catalog_grant" SET "extra_permissions" = array_replace(array_replace(
  "extra_permissions", 'manage_event_posters', 'manage_event_artwork'), 'publish_event_posters', 'publish_event_artwork')
WHERE "extra_permissions" && ARRAY['manage_event_posters','publish_event_posters']::text[];

-- 5. Audit facets (resource/subject_type/details) -- same class of bug as #4:
--    web/src/lib/audit/model.ts and event-artwork-access.ts write "event_poster"
--    as a typed facet value, independent of the enum action names above.
--    `details` additionally carries, as plain data rather than a name Prisma
--    tracks: the payload key "previousPosterId" (case-sensitive -- distinct
--    from "posterId", not caught by that replace), and free-text summary/
--    label strings written at audit time by buildAuditSummary/logArtworkAudit
--    (pre-rename: "Poster candidate created for Event 12 poster", etc).
UPDATE "audit_log" SET "resource" = 'event_artwork' WHERE "resource" = 'event_poster';
UPDATE "audit_log" SET "subject_type" = 'event_artwork' WHERE "subject_type" = 'event_poster';

-- A DO block with a local variable, rather than one deeply nested replace()
-- expression, so each substitution is a plain, independently-checkable
-- statement (a mismatched paren in an 8-deep nested call fails silently
-- until it doesn't -- it did, during review of this very migration).
DO $$
DECLARE
  row_record RECORD;
  rewritten text;
BEGIN
  FOR row_record IN
    SELECT "id", "details"::text AS details_text FROM "audit_log"
    WHERE "details"::text LIKE '%"posterId"%'
       OR "details"::text LIKE '%"previousPosterId"%'
       OR "details"::text LIKE '%"event_poster"%'
  LOOP
    rewritten := row_record.details_text;
    rewritten := replace(rewritten, '"posterId"', '"artworkId"');
    rewritten := replace(rewritten, '"previousPosterId"', '"previousArtworkId"');
    rewritten := replace(rewritten, '"event_poster"', '"event_artwork"');
    rewritten := replace(rewritten, 'Poster candidate created for', 'Artwork candidate created for');
    rewritten := replace(rewritten, 'Poster candidate deleted for', 'Artwork candidate deleted for');
    rewritten := replace(rewritten, 'Poster published for', 'Artwork published for');
    rewritten := replace(rewritten, 'Poster unpublished for', 'Artwork unpublished for');
    -- Trailing subject label, e.g. "...for Event 12 poster" and the
    -- subjectSnapshot.label field itself, "Event 12 poster".
    rewritten := replace(rewritten, ' poster"', ' artwork"');

    UPDATE "audit_log" SET "details" = rewritten::jsonb WHERE "id" = row_record.id;
  END LOOP;
END $$;

-- 6. Guard: fail the migration loudly rather than leave a silent partial rename.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "catalog_access" WHERE "extra_permissions" && ARRAY['manage_event_posters','publish_event_posters']::text[])
  OR EXISTS (SELECT 1 FROM "pending_catalog_grant" WHERE "extra_permissions" && ARRAY['manage_event_posters','publish_event_posters']::text[])
  OR EXISTS (SELECT 1 FROM "audit_log" WHERE "resource" = 'event_poster' OR "subject_type" = 'event_poster')
  OR EXISTS (SELECT 1 FROM "audit_log" WHERE "details"::text LIKE '%"posterId"%'
                                            OR "details"::text LIKE '%"previousPosterId"%'
                                            OR "details"::text LIKE '%"event_poster"%'
                                            OR "details"::text LIKE '%Poster %'
                                            OR "details"::text LIKE '% poster"%') THEN
    RAISE EXCEPTION 'Poster names survived the artwork rename';
  END IF;
END $$;
