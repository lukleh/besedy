-- Remove the retired enhanced-audio "listening" variants (#241).
-- Nothing has written these tables since the enhanced-audio pipeline was
-- removed; both were empty in production when this was written.

-- DropForeignKey
ALTER TABLE "workflow_variant" DROP CONSTRAINT "workflow_variant_workflow_group_id_fkey";

-- DropForeignKey
ALTER TABLE "catalog_listening_entry" DROP CONSTRAINT "catalog_listening_entry_workflow_group_id_fkey";

-- DropForeignKey
ALTER TABLE "catalog_listening_entry" DROP CONSTRAINT "catalog_listening_entry_workflow_group_id_variant_fkey";

-- DropTable
DROP TABLE "workflow_variant";

-- DropTable
DROP TABLE "catalog_listening_entry";
