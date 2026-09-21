-- Drop the legacy access-level scale from the schema.
--
-- 20260916170000_assign_catalog_roles moved every grant onto a role, and the
-- web release that stopped reading `access_level` (#151) is live. The column
-- has been a write-time projection with no reader since; this removes it and
-- makes `role` what the schema requires, not merely what every row happens to
-- carry (docs/adr/0005-catalog-permission-model.md, #166).

-- 1. Refuse to run while any grant lacks a role. SET NOT NULL below would fail
--    on such a row anyway; the explicit check names the cause instead of a
--    constraint error, and points at the migration that assigns roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "catalog_access" WHERE "role" IS NULL)
     OR EXISTS (SELECT 1 FROM "pending_catalog_grant" WHERE "role" IS NULL) THEN
    RAISE EXCEPTION 'catalog grant without a role: run 20260916170000_assign_catalog_roles before dropping access_level';
  END IF;
END
$$;

-- 2. The role is required from here on.
ALTER TABLE "catalog_access"         ALTER COLUMN "role" SET NOT NULL;
ALTER TABLE "pending_catalog_grant"  ALTER COLUMN "role" SET NOT NULL;

-- 3. The legacy column and its enum. No index or constraint references either.
ALTER TABLE "catalog_access"         DROP COLUMN "access_level";
ALTER TABLE "pending_catalog_grant"  DROP COLUMN "access_level";
DROP TYPE "AccessLevel";
