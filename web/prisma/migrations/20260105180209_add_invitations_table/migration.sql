-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_CONSUMED';
ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_UPDATED';

-- Enable pgcrypto for gen_random_uuid() on PostgreSQL < 13
-- On PG 13+, gen_random_uuid() is built-in, but CREATE EXTENSION IF NOT EXISTS is idempotent
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "catalog_id" VARCHAR(15),
    "access_level" "AccessLevel",
    "invited_by_id" TEXT NOT NULL,
    "invited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),
    "consumed_by_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_email_key" ON "invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_consumed_by_id_key" ON "invitations"("consumed_by_id");

-- CreateIndex
CREATE INDEX "invitations_consumed_at_idx" ON "invitations"("consumed_at");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "workflow_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_consumed_by_id_fkey" FOREIGN KEY ("consumed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Data Migration: Move PENDING users to invitations table
-- ============================================================================
-- PENDING users are those who were invited but haven't logged in yet.
-- We migrate their data to the new invitations table, then delete them.
-- When they log in via OAuth, they'll be created fresh with linked accounts.

-- Migrate PENDING users with their catalog access to invitations
-- Uses DISTINCT ON to handle users with multiple catalog access rows
-- (picks the most recent catalog access by created_at for each user)
-- Note: If a PENDING user had access to multiple catalogs, only one will be migrated.
-- This is acceptable because the new invitation model is one-invitation-per-email.
INSERT INTO "invitations" (
    "id",
    "email",
    "catalog_id",
    "access_level",
    "invited_by_id",
    "invited_at",
    "notes",
    "created_at",
    "updated_at"
)
SELECT DISTINCT ON (u.email)
    gen_random_uuid()::text,
    u.email,
    ca.catalog_id,
    ca.access_level,
    u.invited_by_id,
    COALESCE(u.invited_at, u.created_at),
    COALESCE(ca.notes, 'Migrated from PENDING user'),
    u.created_at,
    NOW()
FROM users u
LEFT JOIN catalog_access ca ON ca.user_id = u.id AND ca.status = 'ACTIVE'
WHERE u.status = 'PENDING'
  AND u.email IS NOT NULL
  AND u.invited_by_id IS NOT NULL
ORDER BY u.email, ca.created_at DESC NULLS LAST;

-- Delete PENDING users (cascades to catalog_access, sessions, accounts)
-- This is safe because PENDING users have never logged in (no sessions/accounts)
DELETE FROM users WHERE status = 'PENDING';
