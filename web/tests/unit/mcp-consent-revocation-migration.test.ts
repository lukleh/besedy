import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260827120000_revoke_refresh_tokens_with_oauth_consent/migration.sql',
  ),
  'utf8',
);

describe('OAuth consent revocation migration', () => {
  it('revokes the matching refresh family inside consent deletion', () => {
    expect(migration).toContain('BEFORE INSERT OR DELETE ON "oauthConsent"');
    expect(migration).toContain('DELETE FROM "oauthRefreshToken"');
    expect(migration).toContain('family_client_id := OLD."clientId"');
    expect(migration).toContain('family_user_id := OLD."userId"');
    expect(migration).toContain(
      '"referenceId" IS NOT DISTINCT FROM family_reference_id',
    );
  });

  it('clears an orphaned family before replacement consent is inserted', () => {
    expect(migration).toContain('family_client_id := NEW."clientId"');
    expect(migration).toContain('family_user_id := NEW."userId"');
    expect(migration).toContain('family_reference_id := NEW."referenceId"');
  });

  it('serializes token creation and requires matching live consent', () => {
    expect(migration.match(/pg_advisory_xact_lock/g)).toHaveLength(2);
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OF "clientId", "userId", "referenceId"',
    );
    expect(migration).toContain('FROM "oauthConsent"');
    expect(migration).toContain('"clientId" = NEW."clientId"');
    expect(migration).toContain('"userId" = NEW."userId"');
    expect(migration).toContain(
      '"referenceId" IS NOT DISTINCT FROM NEW."referenceId"',
    );
    expect(migration).toContain("ERRCODE = '23503'");
  });
});
