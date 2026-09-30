-- AAC-in-MP4 copies written next to the Opus WebM by `catalog archive` (#291).
-- Nullable: rows without a copy keep serving the WebM.
-- AlterTable
ALTER TABLE "catalog_entry" ADD COLUMN     "compressed_aac_path" TEXT;

-- AlterTable
ALTER TABLE "catalog_listening_entry" ADD COLUMN     "compressed_aac_path" TEXT;
