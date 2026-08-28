'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { Activity, Bot, Clock3, Database, Users, Wrench } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fetchJson } from '@/lib/api/fetch-json';
import { chartColors, chartConfig, tooltipStyle } from '@/lib/charts/theme';
import { formatRelativeTime } from '@/lib/date-format';
import { ONE_MINUTE_QUERY_PROFILE } from '@/lib/query/profiles';
import type {
  McpUsageAnalytics,
  McpUsageRange,
} from '@/lib/mcp/usage-analytics';

const ranges: McpUsageRange[] = ['24h', '7d', '30d', '12m'];

function outcomeVariant(outcome: string) {
  if (outcome === 'SUCCESS') return 'secondary' as const;
  if (outcome === 'DENIED') return 'destructive' as const;
  return 'outline' as const;
}

export default function McpUsagePage() {
  const t = useTranslations('admin.mcp');
  const locale = useLocale();
  const [range, setRange] = useState<McpUsageRange>('7d');
  const { data, isLoading, error } = useQuery<McpUsageAnalytics>({
    queryKey: ['admin-mcp-usage', range],
    queryFn: () =>
      fetchJson<McpUsageAnalytics>(`/api/admin/mcp-usage?range=${range}`),
    ...ONE_MINUTE_QUERY_PROFILE,
  });
  const number = new Intl.NumberFormat(locale);
  const successRate = data?.summary.totalCalls
    ? (data.summary.successes / data.summary.totalCalls) * 100
    : 0;
  const chartData =
    data?.buckets.map((bucket) => {
      const date = new Date(bucket.timestamp);
      return {
        ...bucket,
        label:
          range === '24h'
            ? date.toLocaleTimeString(locale, {
                hour: '2-digit',
                minute: '2-digit',
              })
            : range === '12m'
              ? date.toLocaleDateString(locale, { month: 'short' })
              : date.toLocaleDateString(locale, {
                  month: 'short',
                  day: 'numeric',
                }),
      };
    }) ?? [];

  const stats = [
    {
      icon: Activity,
      label: t('metrics.calls'),
      value: number.format(data?.summary.totalCalls ?? 0),
    },
    {
      icon: Users,
      label: t('metrics.users'),
      value: number.format(data?.summary.uniqueUsers ?? 0),
    },
    {
      icon: Bot,
      label: t('metrics.clients'),
      value: number.format(data?.summary.uniqueClients ?? 0),
    },
    {
      icon: Wrench,
      label: t('metrics.successRate'),
      value: `${successRate.toFixed(1)}%`,
    },
    {
      icon: Clock3,
      label: t('metrics.averageDuration'),
      value: `${number.format(data?.summary.averageDurationMs ?? 0)} ms`,
    },
    {
      icon: Database,
      label: t('metrics.returnedText'),
      value: number.format(data?.summary.returnedTextChars ?? 0),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {t('title')}
          </h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            {t('description')}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border p-1">
          {ranges.map((value) => (
            <Button
              key={value}
              variant={range === value ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setRange(value)}
              className="h-8 px-2 text-xs"
            >
              {t(`ranges.${value}`)}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {t('error')}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        {stats.map(({ icon: Icon, label, value }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Icon className="h-4 w-4" />
                {label}
              </div>
              {isLoading ? (
                <Skeleton className="mt-2 h-8 w-20" />
              ) : (
                <div className="mt-1 text-2xl font-semibold">{value}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('activity.title')}</CardTitle>
          <CardDescription>{t('activity.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-[260px] w-full" />
          ) : chartData.length === 0 ? (
            <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
              {t('empty')}
            </div>
          ) : (
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={chartConfig.margin}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} />
                  <YAxis
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle.contentStyle}
                    labelStyle={tooltipStyle.labelStyle}
                  />
                  <Bar
                    dataKey="calls"
                    name={t('metrics.calls')}
                    fill={chartColors.adminActions}
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('tools.title')}</CardTitle>
          <CardDescription>{t('tools.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.tool')}</TableHead>
                <TableHead className="text-right">
                  {t('columns.calls')}
                </TableHead>
                <TableHead className="text-right">
                  {t('columns.users')}
                </TableHead>
                <TableHead className="text-right">
                  {t('columns.success')}
                </TableHead>
                <TableHead className="text-right">
                  {t('columns.average')}
                </TableHead>
                <TableHead className="text-right">{t('columns.p95')}</TableHead>
                <TableHead>{t('columns.lastUsed')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.tools.map((tool) => (
                <TableRow key={tool.toolName}>
                  <TableCell className="font-mono font-medium">
                    {tool.toolName}
                  </TableCell>
                  <TableCell className="text-right">{tool.calls}</TableCell>
                  <TableCell className="text-right">
                    {tool.uniqueUsers}
                  </TableCell>
                  <TableCell className="text-right">
                    {tool.calls
                      ? `${((tool.successes / tool.calls) * 100).toFixed(1)}%`
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {tool.averageDurationMs} ms
                  </TableCell>
                  <TableCell className="text-right">
                    {tool.p95DurationMs === null
                      ? '—'
                      : `${tool.p95DurationMs} ms`}
                  </TableCell>
                  <TableCell>
                    {formatRelativeTime(tool.lastUsedAt, locale)}
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && data?.tools.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {t('empty')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t('users.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.user')}</TableHead>
                  <TableHead className="text-right">
                    {t('columns.calls')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('columns.tools')}
                  </TableHead>
                  <TableHead>{t('columns.lastUsed')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.users.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell>
                      <div className="font-medium">
                        {user.name ?? user.email ?? user.userId}
                      </div>
                      {user.name && user.email && (
                        <div className="text-xs text-muted-foreground">
                          {user.email}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{user.calls}</TableCell>
                    <TableCell className="text-right">
                      {user.toolsUsed}
                    </TableCell>
                    <TableCell>
                      {formatRelativeTime(user.lastUsedAt, locale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('clients.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.client')}</TableHead>
                  <TableHead className="text-right">
                    {t('columns.calls')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('columns.users')}
                  </TableHead>
                  <TableHead>{t('columns.lastUsed')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.clients.map((client) => (
                  <TableRow key={client.clientId}>
                    <TableCell>
                      <div className="font-medium">
                        {client.clientName ?? client.clientId}
                      </div>
                      {client.clientName && (
                        <div className="max-w-64 truncate text-xs text-muted-foreground">
                          {client.clientId}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{client.calls}</TableCell>
                    <TableCell className="text-right">
                      {client.uniqueUsers}
                    </TableCell>
                    <TableCell>
                      {formatRelativeTime(client.lastUsedAt, locale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('catalogs.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.catalog')}</TableHead>
                  <TableHead className="text-right">
                    {t('columns.calls')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('columns.users')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.catalogs.map((catalog) => (
                  <TableRow key={catalog.catalogId}>
                    <TableCell>
                      <div className="font-medium">
                        {catalog.catalogLabel ?? catalog.catalogId}
                      </div>
                      {catalog.catalogLabel && (
                        <div className="text-xs text-muted-foreground">
                          {catalog.catalogId}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {catalog.calls}
                    </TableCell>
                    <TableCell className="text-right">
                      {catalog.uniqueUsers}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('recent.title')}</CardTitle>
          <CardDescription>{t('recent.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.time')}</TableHead>
                <TableHead>{t('columns.user')}</TableHead>
                <TableHead>{t('columns.client')}</TableHead>
                <TableHead>{t('columns.tool')}</TableHead>
                <TableHead>{t('columns.catalog')}</TableHead>
                <TableHead>{t('columns.outcome')}</TableHead>
                <TableHead className="text-right">
                  {t('columns.duration')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.recent.map((invocation) => (
                <TableRow key={invocation.id}>
                  <TableCell>
                    {formatRelativeTime(invocation.createdAt, locale)}
                  </TableCell>
                  <TableCell>
                    {invocation.user?.name ?? invocation.user?.email ?? (
                      <span className="font-mono text-xs">
                        {invocation.actorUserId}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {invocation.clientName ?? invocation.clientId}
                  </TableCell>
                  <TableCell className="font-mono">
                    {invocation.toolName}
                  </TableCell>
                  <TableCell>{invocation.catalogId ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={outcomeVariant(invocation.outcome)}>
                      {invocation.outcome.toLowerCase()}
                    </Badge>
                    {invocation.errorCode && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {invocation.errorCode}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {invocation.durationMs} ms
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
