"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useTranslations } from "next-intl";
import { Music, Users, Disc } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { chartColors, chartConfig, tooltipStyle } from "@/lib/charts/theme";

interface TopUser {
  userId: string;
  name: string | null;
  email: string;
  count: number;
}

interface TimeBucket {
  timestamp: string;
  label: string;
  audio: {
    plays: number;
    uniqueUsers: number;
  };
}

interface AudioEngagementChartProps {
  data: TimeBucket[];
  summary: {
    totalPlays: number;
    uniqueUsers: number;
    uniqueTracks: number;
    topUsers: TopUser[];
  };
  comparison: {
    totalPlays: number;
    uniqueUsers: number;
  };
  isLoading?: boolean;
}

export function AudioEngagementChart({
  data,
  summary,
  comparison,
  isLoading,
}: AudioEngagementChartProps) {
  const t = useTranslations("admin.audit.overview.audio");

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[200px] w-full" />
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const chartData = data.map((bucket) => ({
    label: bucket.label,
    plays: bucket.audio.plays,
    users: bucket.audio.uniqueUsers,
  }));

  const playsDiff = summary.totalPlays - comparison.totalPlays;
  const usersDiff = summary.uniqueUsers - comparison.uniqueUsers;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Music className="h-4 w-4" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[200px]">
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
              />
              <Tooltip
                contentStyle={tooltipStyle.contentStyle}
                labelStyle={tooltipStyle.labelStyle}
              />
              <Line
                type="monotone"
                dataKey="plays"
                name={t("plays")}
                stroke={chartColors.plays}
                strokeWidth={2}
                dot={{ r: 2, fill: chartColors.plays }}
                activeDot={{ r: 4, fill: chartColors.plays }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Summary stats */}
        <div className="mt-4 grid grid-cols-3 gap-4">
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Music className="h-3 w-3" />
              <span className="text-xs">{t("plays")}</span>
            </div>
            <div className="text-xl font-semibold">{summary.totalPlays}</div>
            {playsDiff !== 0 && (
              <div
                className={`text-xs ${playsDiff > 0 ? "text-green-600" : "text-red-600"}`}
              >
                {playsDiff > 0 ? "+" : ""}
                {playsDiff}
              </div>
            )}
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Users className="h-3 w-3" />
              <span className="text-xs">{t("uniqueUsers")}</span>
            </div>
            <div className="text-xl font-semibold">{summary.uniqueUsers}</div>
            {usersDiff !== 0 && (
              <div
                className={`text-xs ${usersDiff > 0 ? "text-green-600" : "text-red-600"}`}
              >
                {usersDiff > 0 ? "+" : ""}
                {usersDiff}
              </div>
            )}
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Disc className="h-3 w-3" />
              <span className="text-xs">{t("uniqueTracks")}</span>
            </div>
            <div className="text-xl font-semibold">{summary.uniqueTracks}</div>
          </div>
        </div>

        {/* Top users */}
        {summary.topUsers.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-medium text-muted-foreground mb-2">
              {t("topUsers")}
            </div>
            <div className="space-y-1">
              {summary.topUsers.slice(0, 5).map((user) => (
                <div
                  key={user.userId}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="truncate text-muted-foreground">
                    {user.name || user.email}
                  </span>
                  <span className="font-medium">
                    {user.count} {user.count === 1 ? t("track") : t("tracks")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
