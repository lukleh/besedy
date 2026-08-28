import { Prisma } from '@/generated/prisma/client';
import type { McpToolOutcome } from '@/generated/prisma/enums';
import prisma from '@/lib/db';

export type McpUsageRange = '24h' | '7d' | '30d' | '12m';

interface SummaryRow {
  total_calls: bigint;
  unique_users: bigint;
  unique_clients: bigint;
  successes: bigint;
  errors: bigint;
  denials: bigint;
  average_duration_ms: number | bigint | string | null;
  returned_items: bigint;
  returned_text_chars: bigint;
}

interface ToolRow {
  tool_name: string;
  calls: bigint;
  unique_users: bigint;
  successes: bigint;
  errors: bigint;
  denials: bigint;
  average_duration_ms: number | bigint | string;
  p95_duration_ms: number | bigint | string;
  last_used_at: Date;
}

interface UserRow {
  user_id: string;
  name: string | null;
  email: string | null;
  calls: bigint;
  tools_used: bigint;
  last_used_at: Date;
}

interface ClientRow {
  client_id: string;
  client_name: string | null;
  calls: bigint;
  unique_users: bigint;
  last_used_at: Date;
}

interface CatalogRow {
  catalog_id: string;
  catalog_label: string | null;
  calls: bigint;
  unique_users: bigint;
}

interface BucketRow {
  bucket: Date;
  calls: bigint;
  unique_users: bigint;
  errors: bigint;
}

function toNumber(value: number | bigint | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

export function parseMcpUsageRange(value: string | null): McpUsageRange {
  return value === '24h' || value === '30d' || value === '12m' ? value : '7d';
}

export function getMcpUsagePeriodStart(
  range: McpUsageRange,
  now = new Date(),
): Date {
  const start = new Date(now);
  if (range === '24h') start.setUTCHours(start.getUTCHours() - 24);
  else if (range === '7d') start.setUTCDate(start.getUTCDate() - 7);
  else if (range === '30d') start.setUTCDate(start.getUTCDate() - 30);
  else start.setUTCFullYear(start.getUTCFullYear() - 1);
  return start;
}

function bucketQuery(range: McpUsageRange, periodStart: Date) {
  if (range === '24h') {
    return prisma.$queryRaw<BucketRow[]>(Prisma.sql`
      SELECT date_trunc('hour', created_at) AS bucket,
             COUNT(*)::bigint AS calls,
             COUNT(DISTINCT user_id)::bigint AS unique_users,
             COUNT(*) FILTER (WHERE outcome != 'SUCCESS')::bigint AS errors
      FROM mcp_tool_invocation
      WHERE created_at >= ${periodStart}
      GROUP BY bucket
      ORDER BY bucket
    `);
  }
  if (range === '12m') {
    return prisma.$queryRaw<BucketRow[]>(Prisma.sql`
      SELECT date_trunc('month', created_at) AS bucket,
             COUNT(*)::bigint AS calls,
             COUNT(DISTINCT user_id)::bigint AS unique_users,
             COUNT(*) FILTER (WHERE outcome != 'SUCCESS')::bigint AS errors
      FROM mcp_tool_invocation
      WHERE created_at >= ${periodStart}
      GROUP BY bucket
      ORDER BY bucket
    `);
  }
  return prisma.$queryRaw<BucketRow[]>(Prisma.sql`
    SELECT date_trunc('day', created_at) AS bucket,
           COUNT(*)::bigint AS calls,
           COUNT(DISTINCT user_id)::bigint AS unique_users,
           COUNT(*) FILTER (WHERE outcome != 'SUCCESS')::bigint AS errors
    FROM mcp_tool_invocation
    WHERE created_at >= ${periodStart}
    GROUP BY bucket
    ORDER BY bucket
  `);
}

export async function getMcpUsageAnalytics(range: McpUsageRange) {
  const periodStart = getMcpUsagePeriodStart(range);
  const [
    summaryRows,
    toolRows,
    userRows,
    clientRows,
    catalogRows,
    buckets,
    recent,
  ] = await Promise.all([
    prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS total_calls,
               COUNT(DISTINCT user_id)::bigint AS unique_users,
               COUNT(DISTINCT client_id)::bigint AS unique_clients,
               COUNT(*) FILTER (WHERE outcome = 'SUCCESS')::bigint AS successes,
               COUNT(*) FILTER (WHERE outcome = 'ERROR')::bigint AS errors,
               COUNT(*) FILTER (WHERE outcome = 'DENIED')::bigint AS denials,
               COALESCE(AVG(duration_ms), 0) AS average_duration_ms,
               COALESCE(SUM(result_count), 0)::bigint AS returned_items,
               COALESCE(SUM(returned_text_chars), 0)::bigint AS returned_text_chars
        FROM mcp_tool_invocation
        WHERE created_at >= ${periodStart}
      `),
    prisma.$queryRaw<ToolRow[]>(Prisma.sql`
        SELECT tool_name,
               COUNT(*)::bigint AS calls,
               COUNT(DISTINCT user_id)::bigint AS unique_users,
               COUNT(*) FILTER (WHERE outcome = 'SUCCESS')::bigint AS successes,
               COUNT(*) FILTER (WHERE outcome = 'ERROR')::bigint AS errors,
               COUNT(*) FILTER (WHERE outcome = 'DENIED')::bigint AS denials,
               ROUND(AVG(duration_ms))::integer AS average_duration_ms,
               ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::integer AS p95_duration_ms,
               MAX(created_at) AS last_used_at
        FROM mcp_tool_invocation
        WHERE created_at >= ${periodStart}
        GROUP BY tool_name
        ORDER BY calls DESC, tool_name ASC
      `),
    prisma.$queryRaw<UserRow[]>(Prisma.sql`
        SELECT invocation.user_id,
               users.name,
               users.email,
               COUNT(*)::bigint AS calls,
               COUNT(DISTINCT invocation.tool_name)::bigint AS tools_used,
               MAX(invocation.created_at) AS last_used_at
        FROM mcp_tool_invocation invocation
        LEFT JOIN users ON users.id = invocation.user_id
        WHERE invocation.created_at >= ${periodStart}
          AND invocation.user_id IS NOT NULL
        GROUP BY invocation.user_id, users.name, users.email
        ORDER BY calls DESC, last_used_at DESC
        LIMIT 20
      `),
    prisma.$queryRaw<ClientRow[]>(Prisma.sql`
        SELECT client_id,
               MAX(client_name) AS client_name,
               COUNT(*)::bigint AS calls,
               COUNT(DISTINCT user_id)::bigint AS unique_users,
               MAX(created_at) AS last_used_at
        FROM mcp_tool_invocation
        WHERE created_at >= ${periodStart}
        GROUP BY client_id
        ORDER BY calls DESC, client_id ASC
        LIMIT 20
      `),
    prisma.$queryRaw<CatalogRow[]>(Prisma.sql`
        SELECT invocation.catalog_id,
               MAX(workflow_group.label) AS catalog_label,
               COUNT(*)::bigint AS calls,
               COUNT(DISTINCT invocation.user_id)::bigint AS unique_users
        FROM mcp_tool_invocation invocation
        LEFT JOIN workflow_group ON workflow_group.id = invocation.catalog_id
        WHERE invocation.created_at >= ${periodStart}
          AND invocation.catalog_id IS NOT NULL
        GROUP BY invocation.catalog_id
        ORDER BY calls DESC, invocation.catalog_id ASC
        LIMIT 20
      `),
    bucketQuery(range, periodStart),
    prisma.mcpToolInvocation.findMany({
      where: { createdAt: { gte: periodStart } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    }),
  ]);

  const summary = summaryRows[0];
  return {
    range,
    periodStart: periodStart.toISOString(),
    summary: {
      totalCalls: toNumber(summary?.total_calls),
      uniqueUsers: toNumber(summary?.unique_users),
      uniqueClients: toNumber(summary?.unique_clients),
      successes: toNumber(summary?.successes),
      errors: toNumber(summary?.errors),
      denials: toNumber(summary?.denials),
      averageDurationMs: Math.round(toNumber(summary?.average_duration_ms)),
      returnedItems: toNumber(summary?.returned_items),
      returnedTextChars: toNumber(summary?.returned_text_chars),
    },
    buckets: buckets.map((row) => ({
      timestamp: row.bucket.toISOString(),
      calls: toNumber(row.calls),
      uniqueUsers: toNumber(row.unique_users),
      errors: toNumber(row.errors),
    })),
    tools: toolRows.map((row) => ({
      toolName: row.tool_name,
      calls: toNumber(row.calls),
      uniqueUsers: toNumber(row.unique_users),
      successes: toNumber(row.successes),
      errors: toNumber(row.errors),
      denials: toNumber(row.denials),
      averageDurationMs: toNumber(row.average_duration_ms),
      p95DurationMs: toNumber(row.p95_duration_ms),
      lastUsedAt: row.last_used_at.toISOString(),
    })),
    users: userRows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      calls: toNumber(row.calls),
      toolsUsed: toNumber(row.tools_used),
      lastUsedAt: row.last_used_at.toISOString(),
    })),
    clients: clientRows.map((row) => ({
      clientId: row.client_id,
      clientName: row.client_name,
      calls: toNumber(row.calls),
      uniqueUsers: toNumber(row.unique_users),
      lastUsedAt: row.last_used_at.toISOString(),
    })),
    catalogs: catalogRows.map((row) => ({
      catalogId: row.catalog_id,
      catalogLabel: row.catalog_label,
      calls: toNumber(row.calls),
      uniqueUsers: toNumber(row.unique_users),
    })),
    recent: recent.map((row) => ({
      id: row.id,
      userId: row.userId,
      user: row.user,
      clientId: row.clientId,
      clientName: row.clientName,
      toolName: row.toolName,
      catalogId: row.catalogId,
      targetType: row.targetType,
      targetId: row.targetId,
      outcome: row.outcome as McpToolOutcome,
      errorCode: row.errorCode,
      durationMs: row.durationMs,
      resultCount: row.resultCount,
      returnedTextChars: row.returnedTextChars,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export type McpUsageAnalytics = Awaited<
  ReturnType<typeof getMcpUsageAnalytics>
>;
