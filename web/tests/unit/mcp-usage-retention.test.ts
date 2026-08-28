import { spawnSync } from 'node:child_process';
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
const retentionScriptPath = resolve(
  process.cwd(),
  'scripts/mcp-usage-retention.sh',
);
const retentionScript = readFileSync(retentionScriptPath, 'utf8');

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
    expect(retentionScript).toContain('MIN_MCP_RAW_RETENTION_DAYS=30');
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

  it('rejects raw retention that cannot support exact 30-day analytics', () => {
    const result = spawnSync('bash', [retentionScriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MCP_RAW_RETENTION_DAYS: '29',
        MCP_ROLLUP_RETENTION_DAYS: '400',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'MCP_RAW_RETENTION_DAYS must be at least 30',
    );
  });
});
