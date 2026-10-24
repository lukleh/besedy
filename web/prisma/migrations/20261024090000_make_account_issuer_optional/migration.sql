-- Better Auth 1.7.3 restored the 1.6 account identity (providerId +
-- accountId) and no longer writes "issuer". Keep the column, its index, and
-- the legacy-write trigger so the trigger still fills "issuer" for new rows
-- and a rollback to a 1.7.0-1.7.2 build keeps finding them; only the
-- NOT NULL constraint has to go for the client to omit the field.
ALTER TABLE "accounts" ALTER COLUMN "issuer" DROP NOT NULL;
