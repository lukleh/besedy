"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useTranslations } from "next-intl";
import { Users, LogIn, UserPlus } from "lucide-react";
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
  users: {
    logins: number;
    signups: number;
  };
}

interface UserActivityChartProps {
  data: TimeBucket[];
  summary: {
    totalLogins: number;
    activeUsers: number;
    newSignups: number;
  };
  comparison: {
    totalLogins: number;
    activeUsers: number;
    newSignups: number;
  };
  isLoading?: boolean;
}

export function UserActivityChart({
  data,
  summary,
  comparison,
  isLoading,
}: UserActivityChartProps) {
  const t = useTranslations("admin.audit.overview.users");

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
    logins: bucket.users.logins,
    signups: bucket.users.signups,
  }));

  const loginsDiff = summary.totalLogins - comparison.totalLogins;
  const activeUsersDiff = summary.activeUsers - comparison.activeUsers;
  const signupsDiff = summary.newSignups - comparison.newSignups;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={chartConfig.margin}>
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
              <Bar
                dataKey="logins"
                name={t("logins")}
                fill={chartColors.logins}
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="signups"
                name={t("signups")}
                fill={chartColors.signups}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Summary stats */}
        <div className="mt-4 grid grid-cols-3 gap-4">
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <LogIn className="h-3 w-3" />
              <span className="text-xs">{t("logins")}</span>
            </div>
            <div className="text-xl font-semibold">{summary.totalLogins}</div>
            {loginsDiff !== 0 && (
              <div
                className={`text-xs ${loginsDiff > 0 ? "text-green-600" : "text-red-600"}`}
              >
                {loginsDiff > 0 ? "+" : ""}
                {loginsDiff}
              </div>
            )}
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Users className="h-3 w-3" />
              <span className="text-xs">{t("activeUsers")}</span>
            </div>
            <div className="text-xl font-semibold">{summary.activeUsers}</div>
            {activeUsersDiff !== 0 && (
              <div
                className={`text-xs ${activeUsersDiff > 0 ? "text-green-600" : "text-red-600"}`}
              >
                {activeUsersDiff > 0 ? "+" : ""}
                {activeUsersDiff}
              </div>
            )}
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <UserPlus className="h-3 w-3" />
              <span className="text-xs">{t("newSignups")}</span>
            </div>
            <div className="text-xl font-semibold">{summary.newSignups}</div>
            {signupsDiff !== 0 && (
              <div
                className={`text-xs ${signupsDiff > 0 ? "text-green-600" : "text-red-600"}`}
              >
                {signupsDiff > 0 ? "+" : ""}
                {signupsDiff}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
