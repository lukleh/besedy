-- The admin users list reads each user's latest audit entry. A composite index
-- answers that with one index lookup and still serves user_id-only lookups, so
-- it replaces the single-column index.

-- DropIndex
DROP INDEX "audit_log_user_id_idx";

-- CreateIndex
CREATE INDEX "audit_log_user_id_created_at_idx" ON "audit_log"("user_id", "created_at");
