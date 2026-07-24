"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Filter, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResponsiveSelect,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
} from "@/components/ui/responsive-select";
import { Input } from "@/components/ui/input";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { fetchJson } from "@/lib/api/fetch-json";
import { FIVE_MINUTE_QUERY_PROFILE } from "@/lib/query/profiles";
import { ActivityOverview } from "@/components/admin/audit/activity-overview";
import type { UserOption } from "./types";
import { ALL_ACTIONS, formatDomainLabel } from "./utils";
import { useAuditLoadMore } from "./hooks/use-audit-load-more";
import { AuditTimelineGroup } from "./components/audit-timeline-group";
import { LoadingProgressDisplay } from "./components/loading-progress";

export default function AuditPage() {
  const t = useTranslations("admin.audit");
  const adminStatus = useAdminStatus();
  const [actionFilter, setActionFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [domainFilter, setDomainFilter] = useState("");
  const [subjectTypeFilter, setSubjectTypeFilter] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const {
    groups,
    pagination,
    isLoading,
    isLoadingMore,
    loadingProgress,
    error,
    filters,
    loadMore,
    refresh,
    expandedGroups,
    toggleGroup,
  } = useAuditLoadMore({
    actionFilter,
    resourceFilter: "",
    userFilter,
    domainFilter,
    subjectTypeFilter,
    outcomeFilter,
    dateFrom,
    dateTo,
  });

  const { data: users = [] } = useQuery<UserOption[]>({
    queryKey: ["users", "list"],
    queryFn: () => fetchJson<UserOption[]>("/api/admin/users"),
    enabled: adminStatus.canAccessAdmin,
    ...FIVE_MINUTE_QUERY_PROFILE,
  });

  const clearFilters = () => {
    setActionFilter("");
    setUserFilter("");
    setDomainFilter("");
    setSubjectTypeFilter("");
    setOutcomeFilter("");
    setDateFrom("");
    setDateTo("");
  };

  const hasFilters =
    actionFilter ||
    userFilter ||
    domainFilter ||
    subjectTypeFilter ||
    outcomeFilter ||
    dateFrom ||
    dateTo;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="inline-flex items-center rounded-full border bg-muted/40 px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("workspaceBadge")}
          </div>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
            <p className="max-w-3xl text-muted-foreground">{t("descriptionCanonical")}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={refresh} disabled={isLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            {t("refresh")}
          </Button>
        </div>
      </div>

      <ActivityOverview />

      <div className="rounded-2xl border bg-background p-4 shadow-sm">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium">
          <Filter className="h-4 w-4 text-muted-foreground" />
          {t("filters.labelCanonical")}
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("filters.domain")}
            </label>
            <ResponsiveSelect
              value={domainFilter || "__all__"}
              onValueChange={(value) => setDomainFilter(value === "__all__" ? "" : value)}
            >
              <ResponsiveSelectTrigger aria-label={t("filters.domain")}>
                <ResponsiveSelectValue
                  placeholder={t("filters.allDomains")}
                  displayValue={domainFilter ? formatDomainLabel(domainFilter) : undefined}
                />
              </ResponsiveSelectTrigger>
              <ResponsiveSelectContent title={t("filters.domain")}>
                <ResponsiveSelectItem value="__all__">
                  {t("filters.allDomains")}
                </ResponsiveSelectItem>
                {filters.domains.map((domain) => (
                  <ResponsiveSelectItem key={domain} value={domain}>
                    {formatDomainLabel(domain)}
                  </ResponsiveSelectItem>
                ))}
              </ResponsiveSelectContent>
            </ResponsiveSelect>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("filters.targetType")}
            </label>
            <ResponsiveSelect
              value={subjectTypeFilter || "__all__"}
              onValueChange={(value) => setSubjectTypeFilter(value === "__all__" ? "" : value)}
            >
              <ResponsiveSelectTrigger aria-label={t("filters.targetType")}>
                <ResponsiveSelectValue
                  placeholder={t("filters.allTargetTypes")}
                  displayValue={
                    subjectTypeFilter ? formatDomainLabel(subjectTypeFilter) : undefined
                  }
                />
              </ResponsiveSelectTrigger>
              <ResponsiveSelectContent title={t("filters.targetType")}>
                <ResponsiveSelectItem value="__all__">
                  {t("filters.allTargetTypes")}
                </ResponsiveSelectItem>
                {filters.subjectTypes.map((subjectType) => (
                  <ResponsiveSelectItem key={subjectType} value={subjectType}>
                    {formatDomainLabel(subjectType)}
                  </ResponsiveSelectItem>
                ))}
              </ResponsiveSelectContent>
            </ResponsiveSelect>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("filters.outcome")}
            </label>
            <ResponsiveSelect
              value={outcomeFilter || "__all__"}
              onValueChange={(value) => setOutcomeFilter(value === "__all__" ? "" : value)}
            >
              <ResponsiveSelectTrigger aria-label={t("filters.outcome")}>
                <ResponsiveSelectValue
                  placeholder={t("filters.allOutcomes")}
                  displayValue={outcomeFilter || undefined}
                />
              </ResponsiveSelectTrigger>
              <ResponsiveSelectContent title={t("filters.outcome")}>
                <ResponsiveSelectItem value="__all__">
                  {t("filters.allOutcomes")}
                </ResponsiveSelectItem>
                {filters.outcomes.map((outcome) => (
                  <ResponsiveSelectItem key={outcome} value={outcome}>
                    {outcome}
                  </ResponsiveSelectItem>
                ))}
              </ResponsiveSelectContent>
            </ResponsiveSelect>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("filters.action")}
            </label>
            <ResponsiveSelect
              value={actionFilter || "__all__"}
              onValueChange={(value) => setActionFilter(value === "__all__" ? "" : value)}
            >
              <ResponsiveSelectTrigger aria-label={t("filters.action")}>
                <ResponsiveSelectValue
                  placeholder={t("filters.allActions")}
                  displayValue={actionFilter || undefined}
                />
              </ResponsiveSelectTrigger>
              <ResponsiveSelectContent title={t("filters.action")}>
                <ResponsiveSelectItem value="__all__">
                  {t("filters.allActions")}
                </ResponsiveSelectItem>
                {ALL_ACTIONS.map((action) => (
                  <ResponsiveSelectItem key={action} value={action}>
                    {action}
                  </ResponsiveSelectItem>
                ))}
              </ResponsiveSelectContent>
            </ResponsiveSelect>
          </div>

          {adminStatus.canAccessAdmin && (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                {t("filters.user")}
              </label>
              <ResponsiveSelect
                value={userFilter || "__all__"}
                onValueChange={(value) => setUserFilter(value === "__all__" ? "" : value)}
              >
                <ResponsiveSelectTrigger aria-label={t("filters.user")}>
                  <ResponsiveSelectValue
                    placeholder={t("filters.allUsers")}
                    displayValue={
                      userFilter
                        ? users.find((user) => user.id === userFilter)?.name ||
                          users.find((user) => user.id === userFilter)?.email ||
                          userFilter
                        : undefined
                    }
                  />
                </ResponsiveSelectTrigger>
                <ResponsiveSelectContent title={t("filters.user")}>
                  <ResponsiveSelectItem value="__all__">
                    {t("filters.allUsers")}
                  </ResponsiveSelectItem>
                  {users.map((user) => (
                    <ResponsiveSelectItem key={user.id} value={user.id}>
                      {user.name || user.email || user.id}
                    </ResponsiveSelectItem>
                  ))}
                </ResponsiveSelectContent>
              </ResponsiveSelect>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("filters.from")}
            </label>
            <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("filters.to")}
            </label>
            <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </div>

          <div className="flex items-end">
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="mr-1 h-4 w-4" />
                {t("filters.clear")}
              </Button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {isLoading && loadingProgress ? (
          <div className="rounded-2xl border">
            <LoadingProgressDisplay progress={loadingProgress} />
          </div>
        ) : isLoading ? (
          <div className="rounded-2xl border bg-background p-8 text-center text-muted-foreground">
            {t("loading")}
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-2xl border bg-background p-8 text-center">
            <h2 className="text-lg font-semibold">{t("noCanonicalLogsTitle")}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t("noCanonicalLogsDescription")}</p>
          </div>
        ) : (
          groups.map((group) => (
            <AuditTimelineGroup
              key={group.key}
              group={group}
              isExpanded={expandedGroups.has(group.key)}
              onToggle={() => toggleGroup(group.key)}
            />
          ))
        )}
      </div>

      {isLoadingMore && loadingProgress ? (
        <div className="rounded-2xl border">
          <LoadingProgressDisplay progress={loadingProgress} isLoadMore />
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">
            {t("pagination.loaded", {
              count: pagination.loadedCount,
              total: pagination.totalCount,
            })}
            {groups.length > 0 && (
              <span className="ml-2">
                ({t("pagination.groups", { count: groups.length })})
              </span>
            )}
          </div>
          {pagination.hasMore && (
            <Button variant="outline" onClick={loadMore} disabled={isLoadingMore}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isLoadingMore ? "animate-spin" : ""}`} />
              {t("pagination.loadMore")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
