"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Activity,
  Music,
  Users,
  LogIn,
  UserPlus,
  AlertTriangle,
  Ban,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/api/fetch-json";
import { ONE_MINUTE_QUERY_PROFILE } from "@/lib/query/profiles";
import { AudioEngagementChart } from "./charts/audio-engagement-chart";
import { UserActivityChart } from "./charts/user-activity-chart";
import { SecurityEventsChart } from "./charts/security-events-chart";

type TimeRange = "24h" | "7d" | "30d" | "12m";

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
  users: {
    logins: number;
    signups: number;
  };
  security: {
    failedLogins: number;
    accessDenied: number;
    adminActions: number;
  };
}

interface AnalyticsResponse {
  range: TimeRange;
  buckets: TimeBucket[];
  summary: {
    audio: {
      totalPlays: number;
      uniqueUsers: number;
      uniqueTracks: number;
      topUsers: TopUser[];
    };
    users: {
      totalLogins: number;
      activeUsers: number;
      newSignups: number;
    };
    security: {
      failedLogins: number;
      accessDenied: number;
      adminActions: number;
    };
  };
  comparison: {
    audio: { totalPlays: number; uniqueUsers: number };
    users: { totalLogins: number; activeUsers: number; newSignups: number };
    security: { failedLogins: number; accessDenied: number };
  };
}

// Compact stat card for mobile view
function CompactStatCard({
  icon: Icon,
  label,
  value,
  diff,
  invertedTrend = false,
  variant = "default",
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  diff?: number;
  invertedTrend?: boolean;
  variant?: "default" | "warning" | "error";
}) {
  const isPositive = invertedTrend ? (diff ?? 0) < 0 : (diff ?? 0) > 0;
  const showTrend = diff !== undefined && diff !== 0;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border p-3",
        variant === "error" && value > 0 && "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30",
        variant === "warning" && value > 0 && "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          variant === "error" && value > 0
            ? "bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400"
            : variant === "warning" && value > 0
              ? "bg-amber-100 text-amber-600 dark:bg-amber-900 dark:text-amber-400"
              : "bg-muted text-muted-foreground"
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-lg font-semibold">{value}</span>
          {showTrend && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-xs font-medium",
                isPositive ? "text-green-600" : "text-red-600"
              )}
            >
              {(diff ?? 0) > 0 ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {(diff ?? 0) > 0 ? `+${diff}` : diff}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">{label}</div>
      </div>
    </div>
  );
}

export function ActivityOverview() {
  const t = useTranslations("admin.audit.overview");
  const [range, setRange] = useState<TimeRange>("7d");

  const { data, isLoading, error } = useQuery<AnalyticsResponse>({
    queryKey: ["audit-analytics", range],
    queryFn: () => fetchJson<AnalyticsResponse>(`/api/admin/audit/analytics?range=${range}`),
    ...ONE_MINUTE_QUERY_PROFILE,
  });

  // Empty state for charts when loading or no data
  const emptyBuckets: TimeBucket[] = [];
  const emptySummary = {
    audio: { totalPlays: 0, uniqueUsers: 0, uniqueTracks: 0, topUsers: [] },
    users: { totalLogins: 0, activeUsers: 0, newSignups: 0 },
    security: { failedLogins: 0, accessDenied: 0, adminActions: 0 },
  };
  const emptyComparison = {
    audio: { totalPlays: 0, uniqueUsers: 0 },
    users: { totalLogins: 0, activeUsers: 0, newSignups: 0 },
    security: { failedLogins: 0, accessDenied: 0 },
  };

  return (
    <div className="space-y-4">
      {/* Header with time range toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">{t("title")}</h2>
        </div>

        <div className="flex items-center gap-1 rounded-lg border p-1">
          <Button
            variant={range === "24h" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setRange("24h")}
            className={cn("h-7 px-2 text-xs", range !== "24h" && "text-muted-foreground")}
          >
            {t("timeRange.24h")}
          </Button>
          <Button
            variant={range === "7d" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setRange("7d")}
            className={cn("h-7 px-2 text-xs", range !== "7d" && "text-muted-foreground")}
          >
            {t("timeRange.7d")}
          </Button>
          <Button
            variant={range === "30d" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setRange("30d")}
            className={cn("h-7 px-2 text-xs", range !== "30d" && "text-muted-foreground")}
          >
            {t("timeRange.30d")}
          </Button>
          <Button
            variant={range === "12m" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setRange("12m")}
            className={cn("h-7 px-2 text-xs", range !== "12m" && "text-muted-foreground")}
          >
            {t("timeRange.12m")}
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {t("error")}
        </div>
      )}

      {/* Mobile: Compact stats grid (no charts) */}
      <div className="md:hidden grid grid-cols-2 gap-3">
        {isLoading ? (
          <>
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-[68px] rounded-lg" />
            ))}
          </>
        ) : (
          <>
            {/* Audio stats */}
            <CompactStatCard
              icon={Music}
              label={t("audio.plays")}
              value={data?.summary.audio.totalPlays ?? 0}
              diff={(data?.summary.audio.totalPlays ?? 0) - (data?.comparison.audio.totalPlays ?? 0)}
            />
            <CompactStatCard
              icon={Users}
              label={t("audio.uniqueUsers")}
              value={data?.summary.audio.uniqueUsers ?? 0}
              diff={(data?.summary.audio.uniqueUsers ?? 0) - (data?.comparison.audio.uniqueUsers ?? 0)}
            />

            {/* User stats */}
            <CompactStatCard
              icon={LogIn}
              label={t("users.logins")}
              value={data?.summary.users.totalLogins ?? 0}
              diff={(data?.summary.users.totalLogins ?? 0) - (data?.comparison.users.totalLogins ?? 0)}
            />
            <CompactStatCard
              icon={UserPlus}
              label={t("users.newSignups")}
              value={data?.summary.users.newSignups ?? 0}
              diff={(data?.summary.users.newSignups ?? 0) - (data?.comparison.users.newSignups ?? 0)}
            />

            {/* Security stats */}
            <CompactStatCard
              icon={AlertTriangle}
              label={t("security.failedLogins")}
              value={data?.summary.security.failedLogins ?? 0}
              diff={(data?.summary.security.failedLogins ?? 0) - (data?.comparison.security.failedLogins ?? 0)}
              invertedTrend
              variant="error"
            />
            <CompactStatCard
              icon={Ban}
              label={t("security.accessDenied")}
              value={data?.summary.security.accessDenied ?? 0}
              diff={(data?.summary.security.accessDenied ?? 0) - (data?.comparison.security.accessDenied ?? 0)}
              invertedTrend
              variant="warning"
            />
          </>
        )}
      </div>

      {/* Desktop: Full charts grid */}
      <div className="hidden md:grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <AudioEngagementChart
          data={data?.buckets ?? emptyBuckets}
          summary={data?.summary.audio ?? emptySummary.audio}
          comparison={data?.comparison.audio ?? emptyComparison.audio}
          isLoading={isLoading}
        />

        <UserActivityChart
          data={data?.buckets ?? emptyBuckets}
          summary={data?.summary.users ?? emptySummary.users}
          comparison={data?.comparison.users ?? emptyComparison.users}
          isLoading={isLoading}
        />

        <SecurityEventsChart
          data={data?.buckets ?? emptyBuckets}
          summary={data?.summary.security ?? emptySummary.security}
          comparison={data?.comparison.security ?? emptyComparison.security}
          isLoading={isLoading}
        />
      </div>
    </div>
  );
}
