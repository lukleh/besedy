-- Move every grant onto a role, and let a pending grant carry one too.
--
-- This is the step where access deliberately changes, and the only one in the
-- rework that does (docs/adr/0005-catalog-permission-model.md). Until now both
-- representations were valid and `role` was null everywhere, so `access_level`
-- answered for everyone. Afterwards the role answers and the level is kept only
-- because the interface still names it.
--
-- The mapping, and what each one costs:
--
--   LISTENER -> listener   Nothing changes. `listener` carries what LISTENER
--                          carried.
--   VIEWER   -> reader     Loses `see_unreleased`. The legacy scale conflated
--   MEMBER   -> reader     reading with seeing unreleased material; the roles
--                          separate them, and unreleased material becomes an
--                          administrative decision. MEMBER also loses
--                          `download`, which is now granted per account rather
--                          than reached by climbing a scale.
--   EDITOR   -> curator    Gains the rest of the editorial rights. `curator` is
--                          the role that runs the archive's editorial work;
--                          EDITOR named metadata editing alone.
--   OWNER    -> host       Loses everything except reading and granting access,
--                          and gains `download_transcripts` as an extra.
--
-- Measured against production on 2026-09-16 there are 77 LISTENER, one MEMBER
-- and two OWNER grants, and no VIEWER or EDITOR. So in practice this changes
-- three accounts, and the record states what each of them gives up.
--
-- Rows that already carry a role are left alone, which is what lets a seeded
-- environment choose its own roles and still run this migration.

ALTER TABLE "pending_catalog_grant" ADD COLUMN "role" "CatalogRole";
ALTER TABLE "pending_catalog_grant" ADD COLUMN "extra_permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "catalog_access" SET "role" = 'listener' WHERE "role" IS NULL AND "access_level" = 'LISTENER';
UPDATE "catalog_access" SET "role" = 'reader'   WHERE "role" IS NULL AND "access_level" IN ('VIEWER', 'MEMBER');
UPDATE "catalog_access" SET "role" = 'curator'  WHERE "role" IS NULL AND "access_level" = 'EDITOR';
UPDATE "catalog_access"
   SET "role" = 'host',
       "extra_permissions" = ARRAY['download_transcripts']::TEXT[]
 WHERE "role" IS NULL AND "access_level" = 'OWNER';

UPDATE "pending_catalog_grant" SET "role" = 'listener' WHERE "role" IS NULL AND "access_level" = 'LISTENER';
UPDATE "pending_catalog_grant" SET "role" = 'reader'   WHERE "role" IS NULL AND "access_level" IN ('VIEWER', 'MEMBER');
UPDATE "pending_catalog_grant" SET "role" = 'curator'  WHERE "role" IS NULL AND "access_level" = 'EDITOR';
UPDATE "pending_catalog_grant"
   SET "role" = 'host',
       "extra_permissions" = ARRAY['download_transcripts']::TEXT[]
 WHERE "role" IS NULL AND "access_level" = 'OWNER';
