BEGIN;

/*
  Warnings:

  - You are about to drop the column `active_group` on the `user_preferences` table. All the data in the column will be lost.
  - You are about to drop the column `is_default` on the `workflow_group` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "user_preferences" DROP CONSTRAINT "user_preferences_active_group_fkey";

-- AlterTable
ALTER TABLE "user_preferences" DROP COLUMN "active_group";

-- AlterTable
ALTER TABLE "workflow_group" DROP COLUMN "is_default";

-- Remove the retired per-recording audio selection without changing other settings.
UPDATE "user_preferences" SET "settings" = "settings" - 'audioSources'
WHERE "settings" ? 'audioSources';

COMMIT;
