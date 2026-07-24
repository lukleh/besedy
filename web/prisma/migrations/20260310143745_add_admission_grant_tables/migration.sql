-- Introduce the Phase 4 admission/grant tables without changing runtime behavior.

-- CreateEnum
CREATE TYPE "PortalAdmissionStatus" AS ENUM ('PENDING', 'CLAIMED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PortalAdmissionSource" AS ENUM ('STANDALONE', 'PENDING_GRANT');

-- CreateEnum
CREATE TYPE "PortalAdmissionRevocationReason" AS ENUM ('ADMIN_DENIED', 'LAST_SPONSOR_REMOVED');

-- CreateEnum
CREATE TYPE "PendingCatalogGrantStatus" AS ENUM ('PENDING', 'CONSUMED', 'REVOKED');

-- CreateTable
CREATE TABLE "portal_admission" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "source" "PortalAdmissionSource" NOT NULL,
    "status" "PortalAdmissionStatus" NOT NULL,
    "revocation_reason" "PortalAdmissionRevocationReason",
    "admitted_by_id" TEXT,
    "admitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_by_id" TEXT,
    "claimed_at" TIMESTAMP(3),
    "revoked_by_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portal_admission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_catalog_grant" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "catalog_id" VARCHAR(15) NOT NULL,
    "access_level" "AccessLevel" NOT NULL,
    "status" "PendingCatalogGrantStatus" NOT NULL,
    "granted_by_id" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_by_id" TEXT,
    "consumed_at" TIMESTAMP(3),
    "revoked_by_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_catalog_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "portal_admission_email_key" ON "portal_admission"("email");

-- CreateIndex
CREATE INDEX "portal_admission_status_idx" ON "portal_admission"("status");

-- CreateIndex
CREATE INDEX "portal_admission_claimed_by_id_idx" ON "portal_admission"("claimed_by_id");

-- CreateIndex
CREATE INDEX "pending_catalog_grant_status_idx" ON "pending_catalog_grant"("status");

-- CreateIndex
CREATE INDEX "pending_catalog_grant_catalog_id_idx" ON "pending_catalog_grant"("catalog_id");

-- CreateIndex
CREATE INDEX "pending_catalog_grant_email_idx" ON "pending_catalog_grant"("email");

-- CreateIndex
CREATE INDEX "pending_catalog_grant_consumed_by_id_idx" ON "pending_catalog_grant"("consumed_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "pending_catalog_grant_email_catalog_id_key" ON "pending_catalog_grant"("email", "catalog_id");

-- AddForeignKey
ALTER TABLE "portal_admission" ADD CONSTRAINT "portal_admission_admitted_by_id_fkey" FOREIGN KEY ("admitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_admission" ADD CONSTRAINT "portal_admission_claimed_by_id_fkey" FOREIGN KEY ("claimed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_admission" ADD CONSTRAINT "portal_admission_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_catalog_grant" ADD CONSTRAINT "pending_catalog_grant_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "workflow_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_catalog_grant" ADD CONSTRAINT "pending_catalog_grant_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_catalog_grant" ADD CONSTRAINT "pending_catalog_grant_consumed_by_id_fkey" FOREIGN KEY ("consumed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_catalog_grant" ADD CONSTRAINT "pending_catalog_grant_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
