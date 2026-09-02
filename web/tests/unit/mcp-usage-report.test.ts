import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const weeklyReport = readFileSync(
  resolve(process.cwd(), 'scripts/weekly-report.sh'),
  'utf8',
);
const auditCheck = readFileSync(
  resolve(process.cwd(), 'scripts/audit-check.sh'),
  'utf8',
);

describe('MCP usage report', () => {
  it('collects internally consistent summary metrics in one query', () => {
    expect(weeklyReport).toContain('MCP_SUMMARY=$(db_query');
    expect(weeklyReport).not.toContain('MCP_CALLS=$(db_query');
    expect(weeklyReport).toContain(
      "SUM(calls) FILTER (WHERE outcome = 'SUCCESS')",
    );
  });

  it('uses the most recently observed non-null OAuth client name', () => {
    expect(weeklyReport).toContain(
      'ARRAY_AGG(client_name ORDER BY last_used_at DESC)',
    );
    expect(weeklyReport).not.toContain('MAX(client_name)');
  });

  it('fails closed when the database container or a query is unavailable', () => {
    for (const script of [weeklyReport, auditCheck]) {
      expect(script).toContain('DB_CONTAINER_ID="$(compose_cmd ps -q db)"');
      expect(script).toContain('-v ON_ERROR_STOP=1');
      expect(script).not.toContain('|| echo "0"');
      expect(script).toContain("trap 'on_error");
    }
  });
});
