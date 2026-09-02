import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const trustedClientMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260827150000_allow_trusted_refresh_tokens_without_consent/migration.sql',
  ),
  'utf8',
);
const removalMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260902120000_remove_trusted_client_refresh_grants/migration.sql',
  ),
  'utf8',
);

describe('trusted OAuth client refresh grants', () => {
  it('were introduced by the superseded migration', () => {
    expect(trustedClientMigration).toContain(
      'CREATE FUNCTION "synchronize_refresh_tokens_with_trust_change"',
    );
    expect(trustedClientMigration).toContain('"skipConsent" IS TRUE');
  });

  it('are removed so refresh tokens always require live consent', () => {
    expect(removalMigration).toContain(
      'CREATE OR REPLACE FUNCTION "revoke_refresh_tokens_with_oauth_consent"',
    );
    expect(removalMigration).toContain(
      'CREATE OR REPLACE FUNCTION "require_oauth_consent_for_refresh_token"',
    );
    expect(removalMigration).not.toContain('skipConsent');
    expect(removalMigration).not.toContain('oauth-client-grant');
    expect(removalMigration).toContain(
      'DROP TRIGGER IF EXISTS "oauth_client_synchronize_refresh_tokens_with_trust_change" ON "oauthClient"',
    );
    expect(removalMigration).toContain(
      'DROP FUNCTION IF EXISTS "synchronize_refresh_tokens_with_trust_change"()',
    );
  });

  it('keeps the family locks that serialize consent changes with issuance', () => {
    expect(removalMigration.match(/pg_advisory_xact_lock\(/g)).toHaveLength(1);
    expect(
      removalMigration.match(/pg_advisory_xact_lock_shared\(/g),
    ).toHaveLength(1);
    expect(removalMigration).toMatch(
      /IF family_user_id IS NOT NULL THEN\s+DELETE FROM "oauthRefreshToken"/,
    );
    expect(removalMigration).toMatch(
      /IF NOT EXISTS \(\s+SELECT 1\s+FROM "oauthConsent"/,
    );
    expect(removalMigration).toContain("ERRCODE = '23503'");
  });
});
