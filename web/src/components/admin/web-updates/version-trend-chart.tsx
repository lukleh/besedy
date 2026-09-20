'use client';

import {
  LineChart,
  Line,
  Legend,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useTranslations } from 'next-intl';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  categoricalSeriesColors,
  chartConfig,
  neutralSeriesColor,
  tooltipStyle,
  unknownSeriesDash,
} from '@/lib/charts/theme';
import type {
  WebUpdateDailySeries,
  WebUpdateDailySeriesEntry,
} from '@/lib/web-update/analytics';

interface VersionTrendChartProps {
  data: WebUpdateDailySeries;
}

function seriesLabel(
  entry: WebUpdateDailySeriesEntry,
  t: ReturnType<typeof useTranslations>,
): string {
  if (entry.kind === 'other') return t('status.other');
  if (entry.kind === 'unknown') return t('status.unknown');
  return entry.label ?? t('unknownVersion');
}

// Categorical hues go only to real version identities, in a fixed order
// (current first, then by popularity); the aggregate "other"/"unknown"
// buckets stay a neutral, non-hued gray so they never compete visually
// with an actual version's identity color.
function assignSeriesColors(
  series: WebUpdateDailySeriesEntry[],
): Map<string, string> {
  const colorByKey = new Map<string, string>();
  let hueIndex = 0;
  for (const entry of series) {
    if (entry.kind === 'version') {
      colorByKey.set(
        entry.key,
        categoricalSeriesColors[hueIndex % categoricalSeriesColors.length],
      );
      hueIndex += 1;
    } else {
      colorByKey.set(entry.key, neutralSeriesColor);
    }
  }
  return colorByKey;
}

export function VersionTrendChart({ data }: VersionTrendChartProps) {
  const t = useTranslations('admin.webUpdates');

  if (data.series.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('trendTitle')}</CardTitle>
          <CardDescription>{t('trendDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('trendRangeHint')}
          </p>
        </CardContent>
      </Card>
    );
  }

  const chartData = data.points.map((point) => ({
    label: point.label,
    ...point.values,
  }));

  const colorByKey = assignSeriesColors(data.series);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('trendTitle')}</CardTitle>
        <CardDescription>{t('trendDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={chartConfig.margin}>
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11 }}
                interval="preserveStartEnd"
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11 }}
                width={30}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={tooltipStyle.contentStyle}
                labelStyle={tooltipStyle.labelStyle}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {data.series.map((entry) => {
                const color = colorByKey.get(entry.key) ?? neutralSeriesColor;
                return (
                  <Line
                    key={entry.key}
                    type="monotone"
                    dataKey={entry.key}
                    name={seriesLabel(entry, t)}
                    stroke={color}
                    strokeWidth={2}
                    strokeDasharray={
                      entry.kind === 'unknown' ? unknownSeriesDash : undefined
                    }
                    dot={{ r: 2, fill: color }}
                    activeDot={{ r: 4, fill: color }}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
