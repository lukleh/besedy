-- CreateEnum
CREATE TYPE "AccessStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterTable
ALTER TABLE "catalog_access" ADD COLUMN     "revoked_at" TIMESTAMP(3),
ADD COLUMN     "revoked_by_id" TEXT,
ADD COLUMN     "status" "AccessStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE INDEX "catalog_access_status_idx" ON "catalog_access"("status");

-- AddForeignKey
ALTER TABLE "catalog_access" ADD CONSTRAINT "catalog_access_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
