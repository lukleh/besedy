import { beforeEach, describe, expect, it, vi } from 'vitest';
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
