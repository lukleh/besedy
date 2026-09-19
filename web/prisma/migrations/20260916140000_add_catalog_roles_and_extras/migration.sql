-- Let a catalog grant carry a role and extra permissions, without moving anyone
-- onto them yet.
--
-- The rework replaces the ordered access levels with named roles over a set of
-- permissions (docs/adr/0005-catalog-permission-model.md). This is the expand
-- half: both representations become valid at once, `access_level` stays
-- authoritative because `role` is null for every existing grant, and the step
-- that assigns the roles is the only one where anybody's access changes.
--
-- Extras are stored as names rather than as an enum so the set can grow with the
-- permissions it refers to without a migration each time. Resolution ignores a
-- name it does not recognise, which is what keeps that safe.

CREATE TYPE "CatalogRole" AS ENUM ('listener', 'reader', 'corrector', 'host', 'curator', 'catalog_admin');

ALTER TABLE "catalog_access" ADD COLUMN "role" "CatalogRole";
ALTER TABLE "catalog_access" ADD COLUMN "extra_permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
