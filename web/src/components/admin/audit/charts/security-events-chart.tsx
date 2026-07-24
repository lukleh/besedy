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
import { Shield, AlertTriangle, Ban, UserCog } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { chartColors, chartConfig, tooltipStyle } from "@/lib/charts/theme";

interface TimeBucket {
  timestamp: string;
  label: string;
  security: {
    failedLogins: number;
    accessDenied: number;
    adminActions: number;
  };
}

interface SecurityEventsChartProps {
  data: TimeBucket[];
  summary: {
    failedLogins: number;
    accessDenied: number;
    adminActions: number;
  };
  comparison: {
    failedLogins: number;
    accessDenied: number;
  };
  isLoading?: boolean;
}

export function SecurityEventsChart({
  data,
  summary,
  comparison,
  isLoading,
}: SecurityEventsChartProps) {
  const t = useTranslations("admin.audit.overview.security");

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
    failedLogins: bucket.security.failedLogins,
    accessDenied: bucket.security.accessDenied,
    adminActions: bucket.security.adminActions,
  }));

  const failedLoginsDiff = summary.failedLogins - comparison.failedLogins;
  const accessDeniedDiff = summary.accessDenied - comparison.accessDenied;

  // Determine if there are security concerns (decrease is good for these metrics)
  const hasSecurityConcerns =
    summary.failedLogins > 5 || summary.accessDenied > 10;

  return (
    <Card className={hasSecurityConcerns ? "border-amber-500/50" : undefined}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Shield
            className={`h-4 w-4 ${hasSecurityConcerns ? "text-amber-500" : ""}`}
          />
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
                dataKey="failedLogins"
                name={t("failedLogins")}
                stroke={chartColors.failedLogins}
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="accessDenied"
                name={t("accessDenied")}
                stroke={chartColors.accessDenied}
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="adminActions"
                name={t("adminActions")}
                stroke={chartColors.adminActions}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Summary stats */}
        <div className="mt-4 grid grid-cols-3 gap-4">
          <div
            className={`rounded-lg border p-3 ${summary.failedLogins > 5 ? "border-red-500/50 bg-red-500/5" : ""}`}
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              <AlertTriangle
                className={`h-3 w-3 ${summary.failedLogins > 5 ? "text-red-500" : ""}`}
              />
              <span className="text-xs">{t("failedLogins")}</span>
            </div>
            <div
              className={`text-xl font-semibold ${summary.failedLogins > 5 ? "text-red-600" : ""}`}
            >
              {summary.failedLogins}
            </div>
            {failedLoginsDiff !== 0 && (
              <div
                className={`text-xs ${failedLoginsDiff < 0 ? "text-green-600" : "text-red-600"}`}
              >
                {failedLoginsDiff > 0 ? "+" : ""}
                {failedLoginsDiff}
              </div>
            )}
          </div>

          <div
            className={`rounded-lg border p-3 ${summary.accessDenied > 10 ? "border-amber-500/50 bg-amber-500/5" : ""}`}
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              <Ban
                className={`h-3 w-3 ${summary.accessDenied > 10 ? "text-amber-500" : ""}`}
              />
              <span className="text-xs">{t("accessDenied")}</span>
            </div>
            <div
              className={`text-xl font-semibold ${summary.accessDenied > 10 ? "text-amber-600" : ""}`}
            >
              {summary.accessDenied}
            </div>
            {accessDeniedDiff !== 0 && (
              <div
                className={`text-xs ${accessDeniedDiff < 0 ? "text-green-600" : "text-red-600"}`}
              >
                {accessDeniedDiff > 0 ? "+" : ""}
                {accessDeniedDiff}
              </div>
            )}
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <UserCog className="h-3 w-3" />
              <span className="text-xs">{t("adminActions")}</span>
            </div>
            <div className="text-xl font-semibold text-violet-600">
              {summary.adminActions}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
