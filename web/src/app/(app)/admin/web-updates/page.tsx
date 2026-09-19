import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { WebUpdateEventType } from '@/generated/prisma/enums';
import { requireAdminPageAccess } from '@/lib/access/require-admin-page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  formatWebVersion,
  getWebUpdateAnalytics,
  getWebUpdateVersionStatus,
  parseWebUpdateRange,
  type WebUpdateRange,
  type WebUpdateVersionStatus,
} from '@/lib/web-update/analytics';

export const dynamic = 'force-dynamic';

const RANGES: WebUpdateRange[] = ['24h', '7d', '30d'];

function countFor(
  counts: { event: WebUpdateEventType; _count: { _all: number } }[],
  event: WebUpdateEventType,
): number {
  return counts.find((item) => item.event === event)?._count._all ?? 0;
}

function statusBadgeVariant(status: WebUpdateVersionStatus) {
  if (status === 'current') return 'secondary' as const;
  if (status === 'other') return 'outline' as const;
  return 'destructive' as const;
}

interface WebUpdatesPageProps {
  searchParams?: Promise<{ range?: string | string[] }>;
}

export default async function WebUpdatesPage({
  searchParams,
}: WebUpdatesPageProps) {
  await requireAdminPageAccess();
  const params = await searchParams;
  const range = parseWebUpdateRange(params?.range);
  const [t, locale, analytics] = await Promise.all([
    getTranslations('admin.webUpdates'),
    getLocale(),
    getWebUpdateAnalytics(range),
  ]);
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
  const versionStatus = (version: string | null) =>
    getWebUpdateVersionStatus(version, analytics.currentVersion);
  const versionLabel = (version: string | null) => (
    <span className="font-mono text-xs" title={version ?? t('unknownVersion')}>
      {formatWebVersion(version)}
    </span>
  );
  const versionStatusBadge = (version: string | null) => {
    const status = versionStatus(version);
    return (
      <Badge variant={statusBadgeVariant(status)}>
        {t(`status.${status}`)}
      </Badge>
    );
  };
  const lifecycleMetrics = [
    [
      t('metrics.starts'),
      countFor(analytics.eventCounts, WebUpdateEventType.CLIENT_SEEN),
    ],
    [
      t('metrics.detected'),
      countFor(analytics.eventCounts, WebUpdateEventType.UPDATE_DETECTED),
    ],
    [
      t('metrics.completed'),
      countFor(analytics.eventCounts, WebUpdateEventType.ACTIVATION_COMPLETE),
    ],
    [
      t('metrics.delayed'),
      countFor(analytics.eventCounts, WebUpdateEventType.ACTIVATION_DELAYED),
    ],
    [
      t('metrics.blocked'),
      countFor(analytics.eventCounts, WebUpdateEventType.APPLY_BLOCKED),
    ],
    [
      t('metrics.probeFailed'),
      countFor(analytics.eventCounts, WebUpdateEventType.VERSION_PROBE_FAILED),
    ],
  ] as const;
  const versionMetrics = [
    [t('metrics.observedUsers'), analytics.summary.observedUsers],
    [t('metrics.currentUsers'), analytics.summary.currentUsers],
    [t('metrics.otherUsers'), analytics.summary.otherUsers],
    [t('metrics.unknownUsers'), analytics.summary.unknownUsers],
  ] as const;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border p-1">
          {RANGES.map((value) => (
            <Button
              key={value}
              asChild
              variant={range === value ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 px-2 text-xs"
            >
              <Link href={`/admin/web-updates?range=${value}`}>
                {t(`ranges.${value}`)}
              </Link>
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t('deployedVersion')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-lg font-semibold">
            {versionLabel(analytics.currentVersion)}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {versionMetrics.map(([label, value]) => (
          <Card key={label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{value}</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('distributionTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('table.version')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
                <TableHead className="text-right">{t('table.users')}</TableHead>
                <TableHead className="text-right">
                  {t('table.starts')}
                </TableHead>
                <TableHead>{t('table.lastSeen')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analytics.versions.map((item) => (
                <TableRow key={item.clientVersion ?? 'unknown'}>
                  <TableCell>{versionLabel(item.clientVersion)}</TableCell>
                  <TableCell>
                    {versionStatusBadge(item.clientVersion)}
                  </TableCell>
                  <TableCell className="text-right">
                    {item.observedUsers}
                  </TableCell>
                  <TableCell className="text-right">{item.starts}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {item.lastSeenAt
                      ? dateFormatter.format(item.lastSeenAt)
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
              {analytics.versions.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {t('empty')}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('usersTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('table.user')}</TableHead>
                <TableHead>{t('table.version')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
                <TableHead>{t('table.browser')}</TableHead>
                <TableHead>{t('table.lastSeen')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analytics.latestUsers.map((item) => (
                <TableRow key={item.userId}>
                  <TableCell>
                    {item.name ?? item.email ?? t('anonymous')}
                  </TableCell>
                  <TableCell>{versionLabel(item.clientVersion)}</TableCell>
                  <TableCell>
                    {versionStatusBadge(item.clientVersion)}
                  </TableCell>
                  <TableCell>{item.browser ?? '—'}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {dateFormatter.format(item.lastSeenAt)}
                  </TableCell>
                </TableRow>
              ))}
              {analytics.latestUsers.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {t('emptyUsers')}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">{t('lifecycleTitle')}</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          {lifecycleMetrics.map(([label, value]) => (
            <Card key={label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {label}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-bold">{value}</CardContent>
            </Card>
          ))}
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>{t('recentTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('table.time')}</TableHead>
                <TableHead>{t('table.event')}</TableHead>
                <TableHead>{t('table.transition')}</TableHead>
                <TableHead>{t('table.user')}</TableHead>
                <TableHead>{t('table.context')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analytics.recent.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap">
                    {dateFormatter.format(item.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {t(`events.${item.event.toLowerCase()}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {versionLabel(item.clientVersion)} →{' '}
                    {versionLabel(item.targetVersion)}
                  </TableCell>
                  <TableCell>
                    {item.user?.name ?? item.user?.email ?? t('anonymous')}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {[item.routeGroup, item.browser, ...item.blockerKinds]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </TableCell>
                </TableRow>
              ))}
              {analytics.recent.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {t('empty')}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
