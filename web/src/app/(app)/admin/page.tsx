"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations, useLocale } from "next-intl";
import {
  Users,
  UserPlus,
  Settings,
  Clock,
  User,
  AlertCircle,
  ShieldAlert,
  Bug,
  TrendingUp,
  TrendingDown,
  ChevronRight,
  Activity,
  LogIn,
  UserCheck,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/date-format";
import { fetchJson } from "@/lib/api/fetch-json";
import { ONE_MINUTE_QUERY_PROFILE } from "@/lib/query/profiles";

interface RecentActivity {
  id: string;
  createdAt: string;
  action: string;
  resource: string;
  resourceId: string | null;
  user: { name: string | null; email: string | null } | null;
}

interface DashboardStats {
  users: { total: number; active: number; pending: number; blocked: number };
  audit: {
    loginsTodaySuccess: number;
    loginsTodayFailed: number;
    accessDeniedToday: number;
    superadminAccessToday: number;
    loginsYesterdaySuccess: number;
    loginsYesterdayFailed: number;
    accessDeniedYesterday: number;
    superadminAccessYesterday: number;
    recentActivity: RecentActivity[];
  };
  clientErrors: {
    totalToday: number;
    totalYesterday: number;
    bySource: Record<string, { today: number; yesterday: number }>;
  };
}

function TrendBadge({
  today,
  yesterday,
  inverted = false,
}: {
  today: number;
  yesterday: number;
  inverted?: boolean;
}) {
  const diff = today - yesterday;

  if (diff === 0) return null;

  const isPositive = inverted ? diff > 0 : diff < 0;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium",
        isPositive ? "text-green-600" : "text-red-600"
      )}
    >
      {diff > 0 ? (
        <TrendingUp className="h-3 w-3" />
      ) : (
        <TrendingDown className="h-3 w-3" />
      )}
      {diff > 0 ? `+${diff}` : diff}
    </span>
  );
}

function formatActionLabel(action: string): string {
  return action
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

// Attention Card Component
function AttentionCard({
  icon: Icon,
  title,
  count,
  href,
  variant = "warning",
}: {
  icon: React.ElementType;
  title: string;
  count: number;
  href: string;
  variant?: "warning" | "error";
}) {
  return (
    <Link href={href}>
      <Card
        className={cn(
          "transition-all hover:scale-[1.02]",
          variant === "error"
            ? "border-red-200 bg-red-50 hover:border-red-300 dark:border-red-900 dark:bg-red-950/50"
            : "border-amber-200 bg-amber-50 hover:border-amber-300 dark:border-amber-900 dark:bg-amber-950/50"
        )}
      >
        <CardContent className="flex items-center gap-4 p-4">
          <div
            className={cn(
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-full",
              variant === "error"
                ? "bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400"
                : "bg-amber-100 text-amber-600 dark:bg-amber-900 dark:text-amber-400"
            )}
          >
            <Icon className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-2xl font-bold">{count}</div>
            <div className="text-sm text-muted-foreground truncate">{title}</div>
          </div>
          <ChevronRight className="h-5 w-5 text-muted-foreground" />
        </CardContent>
      </Card>
    </Link>
  );
}

// Stat Card Component
function StatCard({
  icon: Icon,
  label,
  value,
  trend,
  trendYesterday,
  trendInverted,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  trend?: number;
  trendYesterday?: number;
  trendInverted?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold">{value}</span>
          {trend !== undefined && trendYesterday !== undefined && (
            <TrendBadge
              today={trend}
              yesterday={trendYesterday}
              inverted={trendInverted}
            />
          )}
        </div>
        <div className="text-sm text-muted-foreground truncate">{label}</div>
      </div>
    </div>
  );
}

// Quick Action Button Component
function QuickActionButton({
  icon: Icon,
  label,
  description,
  href,
}: {
  icon: React.ElementType;
  label: string;
  description: string;
  href: string;
}) {
  return (
    <Link href={href}>
      <Button
        variant="outline"
        className="h-auto w-full justify-start gap-3 p-4 text-left"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{label}</div>
          <div className="text-xs text-muted-foreground truncate">
            {description}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
      </Button>
    </Link>
  );
}

export default function AdminDashboard() {
  const t = useTranslations("admin.dashboard");
  const locale = useLocale();

  const { data: stats, isLoading } = useQuery<DashboardStats>({
    queryKey: ["admin-dashboard-stats"],
    queryFn: () => fetchJson<DashboardStats>("/api/admin/dashboard/stats"),
    ...ONE_MINUTE_QUERY_PROFILE,
  });

  // Calculate attention items
  const attentionItems = [];

  if (!isLoading && stats) {
    if (stats.users.pending > 0) {
      attentionItems.push({
        icon: UserCheck,
        title: t("attention.pendingUsers"),
        count: stats.users.pending,
        href: "/admin/users?status=PENDING",
        variant: "warning" as const,
      });
    }

    if (stats.audit.loginsTodayFailed > 0) {
      attentionItems.push({
        icon: ShieldAlert,
        title: t("attention.failedLogins"),
        count: stats.audit.loginsTodayFailed,
        href: "/admin/audit?action=LOGIN_FAILED",
        variant: "error" as const,
      });
    }

    if (stats.clientErrors.totalToday > 0) {
      attentionItems.push({
        icon: Bug,
        title: t("attention.clientErrors"),
        count: stats.clientErrors.totalToday,
        href: "/admin/client-errors",
        variant: "error" as const,
      });
    }

    if (stats.audit.accessDeniedToday > 0) {
      attentionItems.push({
        icon: AlertCircle,
        title: t("attention.accessDenied"),
        count: stats.audit.accessDeniedToday,
        href: "/admin/audit?action=ACCESS_DENIED",
        variant: "warning" as const,
      });
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>

      {/* Needs Attention Section */}
      {attentionItems.length > 0 && (
        <section>
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            {t("attention.title")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {attentionItems.map((item) => (
              <AttentionCard key={item.href} {...item} />
            ))}
          </div>
        </section>
      )}

      {/* All Clear Message (when no attention items) */}
      {!isLoading && attentionItems.length === 0 && (
        <Card className="border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/50">
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-400">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <div className="font-medium text-green-800 dark:text-green-200">
                {t("attention.allClear")}
              </div>
              <div className="text-sm text-green-600 dark:text-green-400">
                {t("attention.allClearDesc")}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Today's Overview Section */}
      <section>
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
          <Activity className="h-5 w-5" />
          {t("overview.title")}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={Users}
            label={t("overview.activeUsers")}
            value={isLoading ? "..." : stats?.users.active ?? 0}
          />
          <StatCard
            icon={LogIn}
            label={t("overview.loginsToday")}
            value={isLoading ? "..." : stats?.audit.loginsTodaySuccess ?? 0}
            trend={stats?.audit.loginsTodaySuccess}
            trendYesterday={stats?.audit.loginsYesterdaySuccess}
            trendInverted
          />
          <StatCard
            icon={UserCheck}
            label={t("overview.totalUsers")}
            value={isLoading ? "..." : stats?.users.total ?? 0}
          />
          <StatCard
            icon={ShieldCheck}
            label={t("overview.securityEvents")}
            value={
              isLoading
                ? "..."
                : (stats?.audit.accessDeniedToday ?? 0) +
                  (stats?.audit.loginsTodayFailed ?? 0)
            }
            trend={
              (stats?.audit.accessDeniedToday ?? 0) +
              (stats?.audit.loginsTodayFailed ?? 0)
            }
            trendYesterday={
              (stats?.audit.accessDeniedYesterday ?? 0) +
              (stats?.audit.loginsYesterdayFailed ?? 0)
            }
          />
        </div>
      </section>

      {/* Quick Actions Section */}
      <section>
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
          <ChevronRight className="h-5 w-5" />
          {t("quickActions.title")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <QuickActionButton
            icon={UserPlus}
            label={t("quickActions.addUser")}
            description={t("quickActions.addUserDesc")}
            href="/admin/users?action=new"
          />
          <QuickActionButton
            icon={Users}
            label={t("quickActions.manageUsers")}
            description={t("quickActions.manageUsersDesc")}
            href="/admin/users"
          />
          <QuickActionButton
            icon={Settings}
            label={t("quickActions.catalogSettings")}
            description={t("quickActions.catalogSettingsDesc")}
            href="/admin/catalogs"
          />
        </div>
      </section>

      {/* Recent Activity Section */}
      <section>
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Clock className="h-5 w-5" />
                {t("recentActivity.title")}
              </CardTitle>
              <Link
                href="/admin/audit"
                className="text-sm text-primary hover:underline"
              >
                {t("recentActivity.viewAll")}
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                {t("loading")}
              </div>
            ) : !stats?.audit.recentActivity?.length ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                {t("recentActivity.noActivity")}
              </div>
            ) : (
              <div className="space-y-2">
                {stats.audit.recentActivity.slice(0, 5).map((activity) => (
                  <div
                    key={activity.id}
                    className="flex items-center gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                      <User className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {activity.user?.name ||
                            activity.user?.email ||
                            t("recentActivity.system")}
                        </span>
                        <Badge variant="secondary" className="text-xs">
                          {formatActionLabel(activity.action)}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {activity.resource}
                        {activity.resourceId && (
                          <span className="ml-1 font-mono">
                            {activity.resourceId.slice(0, 8)}
                          </span>
                        )}
                        <span className="mx-1">·</span>
                        {formatRelativeTime(activity.createdAt, locale)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
