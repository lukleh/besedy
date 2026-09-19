import { Prisma } from '@/generated/prisma/client';
import { WebUpdateEventType } from '@/generated/prisma/enums';
import prisma from '@/lib/db';
import { normalizeWebVersion } from '@/lib/service-worker/version';

export type WebUpdateRange = '24h' | '7d' | '30d';

interface LatestUserVersionRow {
  user_id: string;
  client_version: string | null;
  browser: string | null;
  created_at: Date;
  name: string | null;
  email: string | null;
}

export type WebUpdateVersionStatus = 'current' | 'other' | 'unknown';

export function parseWebUpdateRange(
  value: string | string[] | undefined,
): WebUpdateRange {
  const selected = Array.isArray(value) ? value[0] : value;
  return selected === '24h' || selected === '30d' ? selected : '7d';
}

export function getWebUpdatePeriodStart(
  range: WebUpdateRange,
  now = new Date(),
): Date {
  const durationMs =
    range === '24h'
      ? 24 * 60 * 60 * 1000
      : range === '7d'
        ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - durationMs);
}

export function getWebUpdateVersionStatus(
  clientVersion: string | null,
  currentVersion: string | null,
): WebUpdateVersionStatus {
  if (!clientVersion) return 'unknown';
  return currentVersion && clientVersion === currentVersion
    ? 'current'
    : 'other';
}

export function formatWebVersion(version: string | null): string {
  if (!version) return '?';
  if (version.length <= 20) return version;
  return `${version.slice(0, 15)}…${version.slice(-4)}`;
}

export async function getWebUpdateAnalytics(range: WebUpdateRange) {
  const periodStart = getWebUpdatePeriodStart(range);
  const currentVersion =
    normalizeWebVersion(process.env.WEB_VERSION) ??
    normalizeWebVersion(process.env.GIT_COMMIT);

  const [eventCounts, startRows, latestUsers, recent] = await Promise.all([
    prisma.webUpdateEvent.groupBy({
      by: ['event'],
      where: { createdAt: { gte: periodStart } },
      _count: { _all: true },
    }),
    prisma.webUpdateEvent.groupBy({
      by: ['clientVersion'],
      where: {
        event: WebUpdateEventType.CLIENT_SEEN,
        createdAt: { gte: periodStart },
      },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.$queryRaw<LatestUserVersionRow[]>(Prisma.sql`
      SELECT latest.user_id,
             latest.client_version,
             latest.browser,
             latest.created_at,
             users.name,
             users.email
      FROM (
        SELECT DISTINCT ON (user_id)
               user_id,
               client_version,
               browser,
               created_at
        FROM web_update_event
        WHERE event = 'CLIENT_SEEN'
          AND user_id IS NOT NULL
          AND created_at >= ${periodStart}
        ORDER BY user_id, created_at DESC
      ) latest
      LEFT JOIN users ON users.id = latest.user_id
      ORDER BY latest.created_at DESC
    `),
    prisma.webUpdateEvent.findMany({
      where: { createdAt: { gte: periodStart } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { name: true, email: true } } },
    }),
  ]);

  const distribution = new Map<
    string,
    {
      clientVersion: string | null;
      starts: number;
      observedUsers: number;
      lastSeenAt: Date | null;
    }
  >();

  for (const row of startRows) {
    distribution.set(row.clientVersion ?? '', {
      clientVersion: row.clientVersion,
      starts: row._count._all,
      observedUsers: 0,
      lastSeenAt: row._max.createdAt,
    });
  }

  for (const row of latestUsers) {
    const key = row.client_version ?? '';
    const existing = distribution.get(key) ?? {
      clientVersion: row.client_version,
      starts: 0,
      observedUsers: 0,
      lastSeenAt: row.created_at,
    };
    existing.observedUsers += 1;
    distribution.set(key, existing);
  }

  const versions = Array.from(distribution.values()).sort((left, right) => {
    const leftStatus = getWebUpdateVersionStatus(
      left.clientVersion,
      currentVersion,
    );
    const rightStatus = getWebUpdateVersionStatus(
      right.clientVersion,
      currentVersion,
    );
    if (leftStatus === 'current' && rightStatus !== 'current') return -1;
    if (rightStatus === 'current' && leftStatus !== 'current') return 1;
    if (left.observedUsers !== right.observedUsers) {
      return right.observedUsers - left.observedUsers;
    }
    return (
      (right.lastSeenAt?.getTime() ?? 0) - (left.lastSeenAt?.getTime() ?? 0)
    );
  });

  const currentUsers = latestUsers.filter(
    (row) =>
      getWebUpdateVersionStatus(row.client_version, currentVersion) ===
      'current',
  ).length;
  const unknownUsers = latestUsers.filter((row) => !row.client_version).length;

  return {
    range,
    periodStart,
    currentVersion,
    summary: {
      observedUsers: latestUsers.length,
      currentUsers,
      otherUsers: latestUsers.length - currentUsers - unknownUsers,
      unknownUsers,
    },
    eventCounts,
    versions,
    latestUsers: latestUsers.map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      clientVersion: row.client_version,
      browser: row.browser,
      lastSeenAt: row.created_at,
    })),
    recent,
  };
}
