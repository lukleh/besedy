import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebUpdateEventType } from '@/generated/prisma/enums';

const mocks = vi.hoisted(() => ({
  groupBy: vi.fn(),
  findMany: vi.fn(),
  queryRaw: vi.fn(),
  deployLogGroupBy: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  default: {
    webUpdateEvent: {
      groupBy: mocks.groupBy,
      findMany: mocks.findMany,
    },
    webDeployLog: {
      groupBy: mocks.deployLogGroupBy,
    },
    $queryRaw: mocks.queryRaw,
  },
}));

import {
  formatWebVersion,
  getWebUpdateAnalytics,
  getWebUpdateDailyVersionSeries,
  getWebUpdatePeriodStart,
  getWebUpdateVersionStatus,
  parseWebUpdateRange,
} from '@/lib/web-update/analytics';

describe('web update analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('WEB_VERSION', 'web-v2-current');
  });

  it('parses supported observation windows and defaults to seven days', () => {
    expect(parseWebUpdateRange('24h')).toBe('24h');
    expect(parseWebUpdateRange(['30d', '7d'])).toBe('30d');
    expect(parseWebUpdateRange('unexpected')).toBe('7d');

    const now = new Date('2026-09-18T12:00:00.000Z');
    expect(getWebUpdatePeriodStart('24h', now).toISOString()).toBe(
      '2026-09-17T12:00:00.000Z',
    );
    expect(getWebUpdatePeriodStart('7d', now).toISOString()).toBe(
      '2026-09-11T12:00:00.000Z',
    );
  });

  it('classifies opaque versions only by equality with the deployed version', () => {
    expect(getWebUpdateVersionStatus('web-v2-current', 'web-v2-current')).toBe(
      'current',
    );
    expect(getWebUpdateVersionStatus('web-v2-another', 'web-v2-current')).toBe(
      'other',
    );
    expect(getWebUpdateVersionStatus(null, 'web-v2-current')).toBe('unknown');
    expect(formatWebVersion('web-v2-12345678901234567890')).toBe(
      'web-v2-12345678…7890',
    );
  });

  it("builds a distribution from starts and each user's latest observation", async () => {
    const currentLastSeen = new Date('2026-09-18T11:00:00.000Z');
    const otherLastSeen = new Date('2026-09-18T10:00:00.000Z');
    const unknownLastSeen = new Date('2026-09-18T09:00:00.000Z');
    const currentDeployedAt = new Date('2026-09-15T08:00:00.000Z');
    mocks.deployLogGroupBy.mockResolvedValue([
      { webVersion: 'web-v2-current', _max: { deployedAt: currentDeployedAt } },
    ]);
    mocks.groupBy
      .mockResolvedValueOnce([
        { event: WebUpdateEventType.CLIENT_SEEN, _count: { _all: 7 } },
      ])
      .mockResolvedValueOnce([
        {
          clientVersion: 'web-v2-current',
          _count: { _all: 3 },
          _max: { createdAt: currentLastSeen },
        },
        {
          clientVersion: 'web-v2-another',
          _count: { _all: 3 },
          _max: { createdAt: otherLastSeen },
        },
        {
          clientVersion: null,
          _count: { _all: 1 },
          _max: { createdAt: unknownLastSeen },
        },
      ]);
    mocks.queryRaw.mockResolvedValue([
      {
        user_id: 'user-current',
        client_version: 'web-v2-current',
        browser: 'Chrome',
        created_at: currentLastSeen,
        name: 'Current User',
        email: 'current@example.test',
      },
      {
        user_id: 'user-other',
        client_version: 'web-v2-another',
        browser: 'Safari',
        created_at: otherLastSeen,
        name: null,
        email: 'other@example.test',
      },
      {
        user_id: 'user-unknown',
        client_version: null,
        browser: null,
        created_at: unknownLastSeen,
        name: null,
        email: 'unknown@example.test',
      },
    ]);
    mocks.findMany.mockResolvedValue([]);

    const analytics = await getWebUpdateAnalytics('7d');

    expect(analytics.summary).toEqual({
      observedUsers: 3,
      currentUsers: 1,
      otherUsers: 1,
      unknownUsers: 1,
    });
    expect(analytics.versions).toEqual([
      {
        clientVersion: 'web-v2-current',
        starts: 3,
        observedUsers: 1,
        lastSeenAt: currentLastSeen,
        deployedAt: currentDeployedAt,
      },
      {
        clientVersion: 'web-v2-another',
        starts: 3,
        observedUsers: 1,
        lastSeenAt: otherLastSeen,
        deployedAt: null,
      },
      {
        clientVersion: null,
        starts: 1,
        observedUsers: 1,
        lastSeenAt: unknownLastSeen,
        deployedAt: null,
      },
    ]);
    expect(analytics.latestUsers[0]).toEqual(
      expect.objectContaining({
        userId: 'user-current',
        clientVersion: 'web-v2-current',
      }),
    );
  });
});

describe('getWebUpdateDailyVersionSeries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('returns an unsupported-range result for 24h without querying', async () => {
    const result = await getWebUpdateDailyVersionSeries('24h', 'en');

    expect(result).toEqual({
      supportsDailyTrend: false,
      series: [],
      points: [],
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it('always features the current version, caps others at the limit, and folds the rest into other/unknown', async () => {
    vi.stubEnv('WEB_VERSION', 'web-v2-current');
    const day = new Date('2026-09-20T00:00:00.000Z');
    mocks.queryRaw.mockResolvedValue([
      { day, client_version: 'web-v2-current', users: 9 },
      ...Array.from({ length: 7 }, (_, i) => ({
        day,
        client_version: `web-v2-other-${i}`,
        users: 7 - i,
      })),
      { day, client_version: '', users: 2 },
    ]);

    const result = await getWebUpdateDailyVersionSeries('7d', 'en');

    expect(
      result.series.map((entry) => ({
        kind: entry.kind,
        version: entry.version,
        isCurrent: entry.isCurrent,
      })),
    ).toEqual([
      { kind: 'version', version: 'web-v2-current', isCurrent: true },
      { kind: 'version', version: 'web-v2-other-0', isCurrent: false },
      { kind: 'version', version: 'web-v2-other-1', isCurrent: false },
      { kind: 'version', version: 'web-v2-other-2', isCurrent: false },
      { kind: 'version', version: 'web-v2-other-3', isCurrent: false },
      { kind: 'version', version: 'web-v2-other-4', isCurrent: false },
      { kind: 'version', version: 'web-v2-other-5', isCurrent: false },
      { kind: 'other', version: null, isCurrent: false },
      { kind: 'unknown', version: null, isCurrent: false },
    ]);

    // The least-popular "other" version (other-6) and the unknown bucket
    // both land in their respective aggregate series for that day.
    const lastPoint = result.points.at(-1)!;
    const otherKey = result.series.find((e) => e.kind === 'other')!.key;
    const unknownKey = result.series.find((e) => e.kind === 'unknown')!.key;
    expect(lastPoint.values[otherKey]).toBe(1);
    expect(lastPoint.values[unknownKey]).toBe(2);
  });

  it('features up to the limit of other versions even without a current version', async () => {
    vi.stubEnv('WEB_VERSION', '');
    const day = new Date('2026-09-20T00:00:00.000Z');
    mocks.queryRaw.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({
        day,
        client_version: `web-v2-other-${i}`,
        users: 7 - i,
      })),
    );

    const result = await getWebUpdateDailyVersionSeries('7d', 'en');

    const versionEntries = result.series.filter((e) => e.kind === 'version');
    expect(versionEntries).toHaveLength(6);
    expect(versionEntries.map((e) => e.version)).toEqual([
      'web-v2-other-0',
      'web-v2-other-1',
      'web-v2-other-2',
      'web-v2-other-3',
      'web-v2-other-4',
      'web-v2-other-5',
    ]);
    expect(result.series.some((e) => e.kind === 'other')).toBe(true);
  });

  it('backfills the full period with zero-value days, in UTC', async () => {
    vi.stubEnv('WEB_VERSION', '');
    mocks.queryRaw.mockResolvedValue([
      {
        day: new Date('2026-09-13T00:00:00.000Z'),
        client_version: 'web-v2-a',
        users: 3,
      },
      {
        day: new Date('2026-09-20T00:00:00.000Z'),
        client_version: 'web-v2-a',
        users: 4,
      },
    ]);

    const result = await getWebUpdateDailyVersionSeries('7d', 'en');

    expect(result.points.map((p) => p.date)).toEqual([
      '2026-09-13',
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
    const key = result.series[0].key;
    expect(result.points.map((p) => p.values[key])).toEqual([
      3, 0, 0, 0, 0, 0, 0, 4,
    ]);
  });

  it('reports a genuinely empty window as supported-but-empty, not unsupported-range', async () => {
    vi.stubEnv('WEB_VERSION', 'web-v2-current');
    mocks.queryRaw.mockResolvedValue([]);

    const result = await getWebUpdateDailyVersionSeries('30d', 'en');

    expect(result.supportsDailyTrend).toBe(true);
    expect(result.series).toEqual([]);
    expect(result.points.length).toBeGreaterThan(0);
  });
});
