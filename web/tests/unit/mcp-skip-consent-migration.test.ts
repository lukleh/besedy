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
  it('preserves serialization while accepting consent or skipConsent', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION "require_oauth_consent_for_refresh_token"',
    );
    expect(migration).toContain('pg_advisory_xact_lock_shared');
    expect(migration).toContain('FROM "oauthClient"');
    expect(migration).toContain('"skipConsent" IS TRUE');
    expect(migration).toContain('FROM "oauthConsent"');
    expect(migration).toMatch(
      /\) AND NOT EXISTS \(\s+SELECT 1\s+FROM "oauthConsent"/,
    );
    expect(migration).toContain("ERRCODE = '23503'");
  });
});
