-- Better Auth 1.7.3+ identifies accounts by providerId + accountId and never
-- reads "issuer". The column, its index, and the legacy-write trigger only
-- kept a rollback to a 1.7.0-1.7.2 build working; that rollback is no longer
-- supported, so a pre-1.7.3 image can no longer write accounts after this.
DROP TRIGGER "accounts_set_issuer_for_legacy_write" ON "accounts";
DROP FUNCTION "set_account_issuer_for_legacy_write"();
DROP INDEX "accounts_issuer_account_id_key";
ALTER TABLE "accounts" DROP COLUMN "issuer";
