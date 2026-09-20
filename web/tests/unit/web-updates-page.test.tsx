import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { WebUpdateEventType } from '@/generated/prisma/enums';
import WebUpdatesPage from '@/app/(app)/admin/web-updates/page';

// VersionTrendChart is a client component nested in the page tree, so its
// useTranslations call needs a real provider -- next-intl/server above only
// covers the page's own (server-side) translations.
const clientMessages = {
  admin: {
    webUpdates: {
      trendTitle: 'Daily version adoption',
      trendDescription: 'Distinct users observed per day.',
      trendRangeHint: 'Select 7 days or 30 days to see the daily trend.',
      trendEmpty: 'No telemetry was recorded in this window yet.',
      unknownVersion: 'Unknown version',
      status: { other: 'Other', unknown: 'Unknown' },
    },
  },
};

const mocks = vi.hoisted(() => ({
  requireAdminPageAccess: vi.fn(),
  getWebUpdateAnalytics: vi.fn(),
  getWebUpdateDailyVersionSeries: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
  getLocale: vi.fn().mockResolvedValue('en'),
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));

vi.mock('@/lib/access/require-admin-page', () => ({
  requireAdminPageAccess: mocks.requireAdminPageAccess,
}));

vi.mock('@/lib/web-update/analytics', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/web-update/analytics')
  >('@/lib/web-update/analytics');
  return {
    ...actual,
    getWebUpdateAnalytics: mocks.getWebUpdateAnalytics,
    getWebUpdateDailyVersionSeries: mocks.getWebUpdateDailyVersionSeries,
  };
});

describe('WebUpdatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminPageAccess.mockResolvedValue(undefined);
    mocks.getWebUpdateDailyVersionSeries.mockResolvedValue({
      supportsDailyTrend: true,
      series: [],
      points: [],
    });
    mocks.getWebUpdateAnalytics.mockResolvedValue({
      range: '30d',
      periodStart: new Date('2026-08-19T12:00:00.000Z'),
      currentVersion: 'web-v2-current',
      summary: {
        observedUsers: 2,
        currentUsers: 1,
        otherUsers: 1,
        unknownUsers: 0,
      },
      eventCounts: [
        { event: WebUpdateEventType.CLIENT_SEEN, _count: { _all: 4 } },
      ],
      versions: [
        {
          clientVersion: 'web-v2-current',
          starts: 2,
          observedUsers: 1,
          lastSeenAt: new Date('2026-09-18T11:00:00.000Z'),
          deployedAt: null,
        },
        {
          clientVersion: 'web-v2-other',
          starts: 2,
          observedUsers: 1,
          lastSeenAt: new Date('2026-09-18T10:00:00.000Z'),
          deployedAt: null,
        },
      ],
      latestUsers: [
        {
          userId: 'user-1',
          name: 'Ada',
          email: 'ada@example.test',
          clientVersion: 'web-v2-current',
          browser: 'Firefox',
          lastSeenAt: new Date('2026-09-18T11:00:00.000Z'),
        },
      ],
      recent: [],
    });
  });

  it('renders version distribution and latest user observations for the selected range', async () => {
    const page = await WebUpdatesPage({
      searchParams: Promise.resolve({ range: '30d' }),
    });
    render(
      <NextIntlClientProvider locale="en" messages={clientMessages}>
        {page}
      </NextIntlClientProvider>,
    );

    expect(mocks.requireAdminPageAccess).toHaveBeenCalledOnce();
    expect(mocks.getWebUpdateAnalytics).toHaveBeenCalledWith('30d');
    expect(mocks.getWebUpdateDailyVersionSeries).toHaveBeenCalledWith(
      '30d',
      'en',
    );
    expect(screen.getByText('distributionTitle')).toBeInTheDocument();
    expect(screen.getByText('usersTitle')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Firefox')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ranges.24h' })).toHaveAttribute(
      'href',
      '/admin/web-updates?range=24h',
    );
  });
});
