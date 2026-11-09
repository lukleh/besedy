BEGIN;

-- Retained records must already carry the current envelope. Do not infer
-- historical actors, subjects, or source provenance during this cutover.
-- AlterTable
ALTER TABLE "audit_log" ALTER COLUMN "details" SET NOT NULL,
ALTER COLUMN "domain" SET NOT NULL,
ALTER COLUMN "subject_type" SET NOT NULL,
ALTER COLUMN "outcome" SET NOT NULL,
ALTER COLUMN "payload_version" SET NOT NULL;

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_current_payload_check" CHECK ((
  "payload_version" = 1
  AND length("domain") > 0 AND length("subject_type") > 0 AND length("outcome") > 0
  AND jsonb_typeof("details" -> 'audit') = 'object'
  AND "details" -> 'audit' -> 'payloadVersion' = to_jsonb("payload_version")
  AND jsonb_typeof("details" -> 'audit' -> 'domain') = 'string'
  AND "details" -> 'audit' ->> 'domain' = "domain"
  AND jsonb_typeof("details" -> 'audit' -> 'subjectType') = 'string'
  AND "details" -> 'audit' ->> 'subjectType' = "subject_type"
  AND jsonb_typeof("details" -> 'audit' -> 'outcome') = 'string'
  AND "details" -> 'audit' ->> 'outcome' = "outcome"
  AND jsonb_typeof("details" -> 'audit' -> 'summary') = 'string'
  AND length("details" -> 'audit' ->> 'summary') > 0
  AND jsonb_typeof("details" -> 'audit' -> 'actorSnapshot') = 'object'
  AND jsonb_typeof("details" -> 'audit' -> 'subjectSnapshot') = 'object'
) IS TRUE);

COMMIT;
