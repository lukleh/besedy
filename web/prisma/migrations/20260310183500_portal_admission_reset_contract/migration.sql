-- Allow compatibility invitation rows to survive inviter deletion.
ALTER TABLE "invitations" ALTER COLUMN "invited_by_id" DROP NOT NULL;

ALTER TABLE "invitations" DROP CONSTRAINT "invitations_invited_by_id_fkey";
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_invited_by_id_fkey"
  FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Audit coverage for explicit delete-and-readmit resets.
ALTER TYPE "AuditAction" ADD VALUE 'PORTAL_ADMISSION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PORTAL_ADMISSION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'PORTAL_ADMISSION_CLAIMED';
ALTER TYPE "AuditAction" ADD VALUE 'PORTAL_ADMISSION_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'PORTAL_ADMISSION_RESET';
ALTER TYPE "AuditAction" ADD VALUE 'PENDING_CATALOG_GRANT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PENDING_CATALOG_GRANT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'PENDING_CATALOG_GRANT_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'PENDING_CATALOG_GRANT_CONSUMED';
