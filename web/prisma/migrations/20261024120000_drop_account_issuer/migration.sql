-- Better Auth 1.7.3+ identifies accounts by providerId + accountId and never
-- reads "issuer". Drop the column with its index and the legacy-write trigger
-- that kept a 1.7.0-1.7.2 build working. Images built before this migration
-- still select "issuer" on every account query, so none of them can run
-- against the migrated database; going back to one needs the pre-deploy dump.
DROP TRIGGER "accounts_set_issuer_for_legacy_write" ON "accounts";
DROP FUNCTION "set_account_issuer_for_legacy_write"();
DROP INDEX "accounts_issuer_account_id_key";
ALTER TABLE "accounts" DROP COLUMN "issuer";
