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
    const beginAt = retentionScript.indexOf('BEGIN;');
    const lockAt = retentionScript.indexOf('pg_advisory_xact_lock');
    const insertAt = retentionScript.indexOf(
      'INSERT INTO mcp_tool_usage_daily',
    );
    const deleteAt = retentionScript.indexOf('DELETE FROM mcp_tool_invocation');
    const rollupDeleteAt = retentionScript.indexOf(
      'DELETE FROM mcp_tool_usage_daily',
    );

    expect(retentionScript).toContain('MCP_RAW_RETENTION_DAYS:-180');
    expect(retentionScript).toContain('MCP_ROLLUP_RETENTION_DAYS:-400');
    expect(retentionScript).toContain('MIN_MCP_ROLLUP_RETENTION_DAYS=366');
    expect(retentionScript).toContain(
      '-v rollup_retention_days="$MCP_ROLLUP_RETENTION_DAYS"',
    );
    expect(retentionScript).toContain('BEGIN;');
    expect(retentionScript).toContain('ON CONFLICT');
    expect(lockAt).toBeGreaterThan(beginAt);
    expect(insertAt).toBeGreaterThan(lockAt);
    expect(deleteAt).toBeGreaterThan(insertAt);
    expect(rollupDeleteAt).toBeGreaterThan(deleteAt);
    expect(retentionScript).toContain('COMMIT;');
  });
});
