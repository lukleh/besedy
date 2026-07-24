ALTER TABLE "audit_log"
  ADD COLUMN "domain" VARCHAR(50),
  ADD COLUMN "subject_type" VARCHAR(50),
  ADD COLUMN "subject_id" VARCHAR(191),
  ADD COLUMN "catalog_id" VARCHAR(191),
  ADD COLUMN "outcome" VARCHAR(20),
  ADD COLUMN "payload_version" INTEGER;

CREATE INDEX "audit_log_domain_created_at_idx"
  ON "audit_log"("domain", "created_at");

CREATE INDEX "audit_log_subject_type_created_at_idx"
  ON "audit_log"("subject_type", "created_at");

CREATE INDEX "audit_log_subject_id_created_at_idx"
  ON "audit_log"("subject_id", "created_at");

CREATE INDEX "audit_log_catalog_id_created_at_idx"
  ON "audit_log"("catalog_id", "created_at");

CREATE INDEX "audit_log_outcome_created_at_idx"
  ON "audit_log"("outcome", "created_at");

CREATE INDEX "audit_log_payload_version_created_at_idx"
  ON "audit_log"("payload_version", "created_at");
