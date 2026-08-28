import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const weeklyReport = readFileSync(
  resolve(process.cwd(), 'scripts/weekly-report.sh'),
  'utf8',
);

describe('MCP usage report', () => {
  it('uses the most recently observed non-null OAuth client name', () => {
    expect(weeklyReport).toContain(
      'ARRAY_AGG(client_name ORDER BY last_used_at DESC)',
    );
    expect(weeklyReport).not.toContain('MAX(client_name)');
  });
});
