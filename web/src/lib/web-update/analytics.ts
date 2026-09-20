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

export function getCurrentWebVersion(): string | null {
  return (
    normalizeWebVersion(process.env.WEB_VERSION) ??
    normalizeWebVersion(process.env.GIT_COMMIT)
  );
}

export async function getWebUpdateAnalytics(range: WebUpdateRange) {
  const periodStart = getWebUpdatePeriodStart(range);
  const currentVersion = getCurrentWebVersion();

  const [eventCounts, startRows, deployRows, latestUsers, recent] =
    await Promise.all([
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
      // Authoritative "when was this deployed" per version, written by `just
      // prod-apply` at the moment each version actually went live -- not to
      // be confused with a commit's timestamp, which only says when the code
      // changed.
      prisma.webDeployLog.groupBy({
        by: ['webVersion'],
        _max: { deployedAt: true },
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

  const deployedAtByVersion = new Map<string, Date>();
  for (const row of deployRows) {
    if (row._max.deployedAt) {
      deployedAtByVersion.set(row.webVersion, row._max.deployedAt);
    }
  }

  const distribution = new Map<
    string,
    {
      clientVersion: string | null;
      starts: number;
      observedUsers: number;
      lastSeenAt: Date | null;
      deployedAt: Date | null;
    }
  >();

  for (const row of startRows) {
    distribution.set(row.clientVersion ?? '', {
      clientVersion: row.clientVersion,
      starts: row._count._all,
      observedUsers: 0,
      lastSeenAt: row._max.createdAt,
      deployedAt: row.clientVersion
        ? (deployedAtByVersion.get(row.clientVersion) ?? null)
        : null,
    });
  }

  for (const row of latestUsers) {
    const key = row.client_version ?? '';
    const existing = distribution.get(key) ?? {
      clientVersion: row.client_version,
      starts: 0,
      observedUsers: 0,
      lastSeenAt: row.created_at,
      deployedAt: row.client_version
        ? (deployedAtByVersion.get(row.client_version) ?? null)
        : null,
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

// A line per version quickly becomes unreadable; past this many distinct
// non-current versions, the rest fold into a single "other" series.
const MAX_FEATURED_VERSIONS = 6;

export type WebUpdateDailySeriesKind = 'version' | 'other' | 'unknown';

export interface WebUpdateDailySeriesEntry {
  key: string;
  kind: WebUpdateDailySeriesKind;
  /** Full version string for kind 'version'; null for the aggregate series. */
  version: string | null;
  /** Pre-formatted display label for kind 'version'; null for the aggregate
   * series, whose label is a translated string chosen by the caller. */
  label: string | null;
  isCurrent: boolean;
}

export interface WebUpdateDailySeriesPoint {
  date: string;
  label: string;
  values: Record<string, number>;
}

export interface WebUpdateDailySeries {
  series: WebUpdateDailySeriesEntry[];
  points: WebUpdateDailySeriesPoint[];
}

interface DailyVersionRow {
  day: Date;
  client_version: string;
  users: number;
}

/**
 * Daily distinct-user counts per web client version, for a version-adoption
 * trend chart. Each user contributes to whichever version they were last
 * seen on that day (mirrors the "latest observation per user" semantics
 * used elsewhere on this page, just bucketed by day instead of by range).
 */
export async function getWebUpdateDailyVersionSeries(
  range: WebUpdateRange,
  locale: string,
): Promise<WebUpdateDailySeries> {
  // A single day of buckets isn't a trend; the page shows a hint instead.
  if (range === '24h') {
    return { series: [], points: [] };
  }

  const currentVersion = getCurrentWebVersion();
  const periodStart = getWebUpdatePeriodStart(range);

  const rows = await prisma.$queryRaw<DailyVersionRow[]>(Prisma.sql`
    WITH daily_latest AS (
      SELECT DISTINCT ON (user_id, day)
             user_id,
             date_trunc('day', created_at)::date AS day,
             client_version
      FROM web_update_event
      WHERE event = 'CLIENT_SEEN'
        AND user_id IS NOT NULL
        AND created_at >= ${periodStart}
      ORDER BY user_id, day, created_at DESC
    )
    SELECT day, COALESCE(client_version, '') AS client_version, COUNT(*)::int AS users
    FROM daily_latest
    GROUP BY day, client_version
    ORDER BY day ASC
  `);

  const totalsByVersion = new Map<string, number>();
  for (const row of rows) {
    totalsByVersion.set(
      row.client_version,
      (totalsByVersion.get(row.client_version) ?? 0) + Number(row.users),
    );
  }

  const rankedOtherVersions = Array.from(totalsByVersion.entries())
    .filter(([version]) => version !== '' && version !== currentVersion)
    .sort((left, right) => right[1] - left[1])
    .map(([version]) => version);

  const featured = new Set<string>();
  if (currentVersion && totalsByVersion.has(currentVersion)) {
    featured.add(currentVersion);
  }
  for (const version of rankedOtherVersions) {
    if (featured.size >= MAX_FEATURED_VERSIONS) break;
    featured.add(version);
  }

  const hasOther = Array.from(totalsByVersion.keys()).some(
    (version) => version !== '' && !featured.has(version),
  );
  const hasUnknown = totalsByVersion.has('');

  const series: WebUpdateDailySeriesEntry[] = [];
  const seriesKeyByVersion = new Map<string, string>();

  if (currentVersion && featured.has(currentVersion)) {
    series.push({
      key: 'current',
      kind: 'version',
      version: currentVersion,
      label: formatWebVersion(currentVersion),
      isCurrent: true,
    });
    seriesKeyByVersion.set(currentVersion, 'current');
  }
  let seriesIndex = 0;
  for (const version of rankedOtherVersions) {
    if (!featured.has(version)) continue;
    const key = `v${seriesIndex++}`;
    series.push({
      key,
      kind: 'version',
      version,
      label: formatWebVersion(version),
      isCurrent: false,
    });
    seriesKeyByVersion.set(version, key);
  }
  if (hasOther) {
    series.push({
      key: 'other',
      kind: 'other',
      version: null,
      label: null,
      isCurrent: false,
    });
  }
  if (hasUnknown) {
    series.push({
      key: 'unknown',
      kind: 'unknown',
      version: null,
      label: null,
      isCurrent: false,
    });
  }

  const seriesKeyFor = (version: string): string => {
    if (version === '') return 'unknown';
    return seriesKeyByVersion.get(version) ?? 'other';
  };

  const valuesByDay = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const dayKey = row.day.toISOString().slice(0, 10);
    const key = seriesKeyFor(row.client_version);
    const dayValues = valuesByDay.get(dayKey) ?? new Map<string, number>();
    dayValues.set(key, (dayValues.get(key) ?? 0) + Number(row.users));
    valuesByDay.set(dayKey, dayValues);
  }

  const dateFormatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  });

  const points: WebUpdateDailySeriesPoint[] = [];
  const cursor = new Date(
    Date.UTC(
      periodStart.getUTCFullYear(),
      periodStart.getUTCMonth(),
      periodStart.getUTCDate(),
    ),
  );
  const now = new Date();
  const endOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  while (cursor <= endOfToday) {
    const dayKey = cursor.toISOString().slice(0, 10);
    const dayValues = valuesByDay.get(dayKey);
    const values: Record<string, number> = {};
    for (const entry of series) {
      values[entry.key] = dayValues?.get(entry.key) ?? 0;
    }
    points.push({ date: dayKey, label: dateFormatter.format(cursor), values });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { series, points };
}
