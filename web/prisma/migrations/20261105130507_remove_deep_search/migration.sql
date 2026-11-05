/*
  Warnings:

  - You are about to drop the `deep_search_job_shares` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "deep_search_job_shares" DROP CONSTRAINT "deep_search_job_shares_catalog_id_fkey";

-- DropForeignKey
ALTER TABLE "deep_search_job_shares" DROP CONSTRAINT "deep_search_job_shares_owner_user_id_fkey";

-- DropForeignKey
ALTER TABLE "deep_search_job_shares" DROP CONSTRAINT "deep_search_job_shares_shared_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "deep_search_job_shares" DROP CONSTRAINT "deep_search_job_shares_shared_with_user_id_fkey";

-- DropTable
DROP TABLE "deep_search_job_shares";

-- Retire only feature-owned grants; preserve every other extra permission.
UPDATE "catalog_access"
SET "extra_permissions" = array_remove("extra_permissions", 'use_deep_search')
WHERE 'use_deep_search' = ANY("extra_permissions");

UPDATE "pending_catalog_grant"
SET "extra_permissions" = array_remove("extra_permissions", 'use_deep_search')
WHERE 'use_deep_search' = ANY("extra_permissions");

-- Labs has no remaining features. Keep unrelated playback/UI preferences.
UPDATE "user_preferences"
SET "settings" = "settings" - 'labs'
WHERE "settings" ? 'labs';
