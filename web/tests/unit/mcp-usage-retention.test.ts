import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260828190000_preserve_and_roll_up_mcp_usage/migration.sql',
  ),
  'utf8',
);
const retentionScript = readFileSync(
  resolve(process.cwd(), 'scripts/mcp-usage-retention.sh'),
  'utf8',
);

describe('MCP usage retention', () => {
  it('preserves an immutable actor ID and exposes raw plus daily usage', () => {
    expect(migration).toContain('ADD COLUMN "actor_user_id" TEXT');
    expect(migration).toContain(
      'SET "actor_user_id" = COALESCE("user_id", \'deleted:\' || "id")',
    );
    expect(migration).toContain('CREATE TABLE "mcp_tool_usage_daily"');
    expect(migration).toContain('CREATE VIEW "mcp_tool_usage"');
    expect(migration).toContain('UNION ALL');
  });

  it('rolls up before deleting expired raw rows in one transaction', () => {
    const insertAt = retentionScript.indexOf(
      'INSERT INTO mcp_tool_usage_daily',
    );
    const deleteAt = retentionScript.indexOf('DELETE FROM mcp_tool_invocation');

    expect(retentionScript).toContain('MCP_RAW_RETENTION_DAYS:-180');
    expect(retentionScript).toContain('BEGIN;');
    expect(retentionScript).toContain('ON CONFLICT');
    expect(insertAt).toBeGreaterThan(0);
    expect(deleteAt).toBeGreaterThan(insertAt);
    expect(retentionScript).toContain('COMMIT;');
  });
});
