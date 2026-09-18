import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const weeklyReport = readFileSync(
  resolve(process.cwd(), 'scripts/weekly-report.sh'),
  'utf8',
);

describe('web update email report', () => {
  it('reads the deployed version from the production web container', () => {
    expect(weeklyReport).toContain(
      'WEB_CONTAINER_ID="$(compose_cmd ps -q web)"',
    );
    expect(weeklyReport).toContain('printenv WEB_VERSION');
    expect(weeklyReport).toContain(
      'Production web container returned an invalid WEB_VERSION',
    );
  });

  it("uses each identified user's latest observation in the report window", () => {
    expect(weeklyReport).toContain(
      'SELECT DISTINCT ON (user_id) user_id, client_version',
    );
    expect(weeklyReport).toContain("event = 'CLIENT_SEEN'");
    expect(weeklyReport).toContain('AND user_id IS NOT NULL');
    expect(weeklyReport).toContain('ORDER BY user_id, created_at DESC');
  });

  it('adds aggregate client version statistics without user identities', () => {
    expect(weeklyReport).toContain('WEB CLIENT VERSIONS');
    expect(weeklyReport).toContain(
      'Observed users:     $CLIENT_OBSERVED_USERS',
    );
    expect(weeklyReport).toContain('Current version:    $CLIENT_CURRENT_USERS');
    expect(weeklyReport).toContain('Latest observation per user:');
    expect(weeklyReport).not.toContain('CLIENT_VERSION_PER_USER');
  });
});
