import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260827150000_allow_trusted_refresh_tokens_without_consent/migration.sql',
  ),
  'utf8',
);

describe('trusted OAuth client refresh migration', () => {
  it('preserves trusted refresh families across consent changes', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION "revoke_refresh_tokens_with_oauth_consent"',
    );
    expect(migration).toContain(
      "jsonb_build_array('oauth-client-grant', family_client_id)",
    );
    expect(migration).toMatch(
      /IF family_user_id IS NOT NULL AND NOT EXISTS \(\s+SELECT 1\s+FROM "oauthClient"\s+WHERE "clientId" = family_client_id\s+AND "skipConsent" IS TRUE\s+\) THEN\s+DELETE FROM "oauthRefreshToken"/,
    );
  });

  it('serializes issuance while accepting consent or skipConsent', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION "require_oauth_consent_for_refresh_token"',
    );
    expect(migration).toContain(
      'jsonb_build_array(\'oauth-client-grant\', NEW."clientId")',
    );
    expect(migration.match(/pg_advisory_xact_lock_shared/g)).toHaveLength(3);
    expect(migration).toContain('FROM "oauthClient"');
    expect(migration).toContain('"skipConsent" IS TRUE');
    expect(migration).toContain('FROM "oauthConsent"');
    expect(migration).toMatch(
      /\) AND NOT EXISTS \(\s+SELECT 1\s+FROM "oauthConsent"/,
    );
    expect(migration).toContain("ERRCODE = '23503'");
  });

  it('revokes unconsented families when trusted status is removed', () => {
    expect(migration).toContain(
      'CREATE FUNCTION "synchronize_refresh_tokens_with_trust_change"',
    );
    expect(migration).toContain(
      'OLD."skipConsent" IS DISTINCT FROM NEW."skipConsent"',
    );
    expect(migration).toContain(
      'OLD."skipConsent" IS TRUE AND NEW."skipConsent" IS NOT TRUE',
    );
    expect(migration).toContain(
      'BEFORE UPDATE OF "skipConsent" ON "oauthClient"',
    );
    expect(migration).toMatch(
      /DELETE FROM "oauthRefreshToken" AS refresh_token\s+WHERE refresh_token\."clientId" = NEW\."clientId"\s+AND NOT EXISTS \(\s+SELECT 1\s+FROM "oauthConsent"/,
    );
    expect(migration).toContain(
      '"referenceId" IS NOT DISTINCT FROM refresh_token."referenceId"',
    );
  });
});
