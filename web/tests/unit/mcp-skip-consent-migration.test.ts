import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const removalMigration = readFileSync(resolve(process.cwd(), 'prisma/migrations/20261108000000_current_schema/migration.sql'), 'utf8');

describe('trusted OAuth client refresh grants', () => {
  it('requires live consent without a trusted-client bypass', () => {
    expect(removalMigration).toContain('CREATE FUNCTION public.revoke_refresh_tokens_with_oauth_consent');
    expect(removalMigration).toContain('CREATE FUNCTION public.require_oauth_consent_for_refresh_token');
    expect(removalMigration).not.toContain('synchronize_refresh_tokens_with_trust_change');
    expect(removalMigration).not.toContain('oauth-client-grant');
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
