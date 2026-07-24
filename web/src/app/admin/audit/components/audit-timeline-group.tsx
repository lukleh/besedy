"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderKanban,
  KeyRound,
  LogIn,
  Shield,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { AuditLog, AuditLogGroup } from "../types";
import {
  formatActionLabel,
  formatDomainLabel,
  formatTimestampRange,
  getActionBadgeVariant,
  getOutcomeBadgeVariant,
} from "../utils";

interface AuditTimelineGroupProps {
  group: AuditLogGroup;
  isExpanded: boolean;
  onToggle: () => void;
}

function formatTimestamp(value: string): string {
  return new Date(value).toISOString().replace("T", " ").slice(0, 19);
}

function getDomainIcon(domain: AuditLog["domain"]) {
  switch (domain) {
    case "auth":
      return <LogIn className="h-5 w-5" />;
    case "admission":
    case "catalog_access":
      return <KeyRound className="h-5 w-5" />;
    case "user":
    case "admin":
      return <UserRound className="h-5 w-5" />;
    case "catalog":
      return <FolderKanban className="h-5 w-5" />;
    case "security":
      return <Shield className="h-5 w-5" />;
    case "content":
    case "data_access":
      return <FileText className="h-5 w-5" />;
    default:
      return <Activity className="h-5 w-5" />;
  }
}

function AuditTimelineEntry({ log }: { log: AuditLog }) {
  const t = useTranslations("admin.audit");
  const [showRawDetails, setShowRawDetails] = useState(false);
  const rawDetails = log.rawDetails ?? log.details;
  const hasRawDetails = Boolean(rawDetails && Object.keys(rawDetails).length > 0);

  return (
    <div className="rounded-lg border bg-background/80 p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="text-xs font-mono text-muted-foreground">
            {formatTimestamp(log.createdAt)}
          </div>
          <div className="font-medium leading-snug">{log.summary}</div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={getActionBadgeVariant(log.action)}>
              {formatActionLabel(log.action)}
            </Badge>
            <Badge variant={getOutcomeBadgeVariant(log.outcome)}>
              {log.outcome}
            </Badge>
            <Badge variant="outline">{formatDomainLabel(log.domain)}</Badge>
          </div>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/admin/audit/${log.id}`}>{t("viewEvent")}</Link>
        </Button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-md bg-muted/40 p-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("cards.actor")}
          </div>
          <div className="mt-1 font-medium">{log.actor.label}</div>
          {log.actor.secondaryLabel && (
            <div className="text-xs text-muted-foreground">{log.actor.secondaryLabel}</div>
          )}
        </div>
        <div className="rounded-md bg-muted/40 p-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("cards.target")}
          </div>
          <div className="mt-1 font-medium">{log.target?.label || log.resource}</div>
          {log.target?.secondaryLabel && (
            <div className="text-xs text-muted-foreground">{log.target.secondaryLabel}</div>
          )}
        </div>
        <div className="rounded-md bg-muted/40 p-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("cards.scope")}
          </div>
          <div className="mt-1 font-medium">
            {log.target?.catalogLabel || log.target?.catalogId || t("cards.none")}
          </div>
          <div className="text-xs text-muted-foreground">
            {log.target?.catalogId || log.resource}
          </div>
        </div>
        <div className="rounded-md bg-muted/40 p-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("cards.resourceId")}
          </div>
          <div className="mt-1 font-mono text-xs break-all">{log.resourceId || "-"}</div>
        </div>
      </div>

      {hasRawDetails && (
        <div className="mt-4">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => setShowRawDetails((value) => !value)}
          >
            {showRawDetails ? (
              <ChevronDown className="mr-1 h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="mr-1 h-3.5 w-3.5" />
            )}
            {showRawDetails ? t("hideDetails") : t("showDetails")}
          </Button>
          {showRawDetails && (
            <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(rawDetails, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function AuditTimelineGroup({
  group,
  isExpanded,
  onToggle,
}: AuditTimelineGroupProps) {
  const t = useTranslations("admin.audit");
  const primaryEntry = group.entries[0];

  if (!primaryEntry) {
    return null;
  }

  return (
    <Card className="overflow-hidden border shadow-sm">
      <CardContent className="p-0">
        <div className="flex items-start gap-4 p-5">
          <div className="hidden rounded-full border bg-muted/40 p-3 text-muted-foreground sm:block">
            {getDomainIcon(primaryEntry.domain)}
          </div>

          <div className="min-w-0 flex-1 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {group.entries.length > 1 && (
                    <Badge variant="secondary">
                      {t("groupedEntries", { count: group.entries.length })}
                    </Badge>
                  )}
                  <span className="font-mono text-xs text-muted-foreground">
                    {group.entries.length > 1
                      ? formatTimestampRange(
                          group.mostRecentTimestamp,
                          group.oldestTimestamp
                        )
                      : formatTimestamp(primaryEntry.createdAt)}
                  </span>
                </div>
                <div className="text-lg font-semibold leading-tight">
                  {primaryEntry.summary}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={getActionBadgeVariant(primaryEntry.action)}>
                    {formatActionLabel(primaryEntry.action)}
                  </Badge>
                  <Badge variant={getOutcomeBadgeVariant(primaryEntry.outcome)}>
                    {primaryEntry.outcome}
                  </Badge>
                  <Badge variant="outline">{formatDomainLabel(primaryEntry.domain)}</Badge>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {group.entries.length > 1 && (
                  <Button variant="ghost" size="sm" onClick={onToggle}>
                    {isExpanded ? (
                      <ChevronDown className="mr-1 h-4 w-4" />
                    ) : (
                      <ChevronRight className="mr-1 h-4 w-4" />
                    )}
                    {isExpanded ? t("collapseGroup") : t("expandGroup")}
                  </Button>
                )}
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/admin/audit/${primaryEntry.id}`}>{t("viewEvent")}</Link>
                </Button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("cards.actor")}
                </div>
                <div className="mt-1 font-medium">{primaryEntry.actor.label}</div>
                {primaryEntry.actor.secondaryLabel && (
                  <div className="text-xs text-muted-foreground">
                    {primaryEntry.actor.secondaryLabel}
                  </div>
                )}
              </div>

              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("cards.target")}
                </div>
                <div className="mt-1 font-medium">
                  {primaryEntry.target?.label || primaryEntry.resource}
                </div>
                {primaryEntry.target?.secondaryLabel && (
                  <div className="text-xs text-muted-foreground">
                    {primaryEntry.target.secondaryLabel}
                  </div>
                )}
              </div>

              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("cards.scope")}
                </div>
                <div className="mt-1 font-medium">
                  {primaryEntry.target?.catalogLabel ||
                    primaryEntry.target?.catalogId ||
                    t("cards.none")}
                </div>
                <div className="text-xs text-muted-foreground">
                  {primaryEntry.target?.catalogId || primaryEntry.resource}
                </div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {primaryEntry.outcome === "denied" || primaryEntry.outcome === "failure" ? (
                    <AlertTriangle className="h-3.5 w-3.5" />
                  ) : null}
                  {t("cards.resourceId")}
                </div>
                <div className="mt-1 font-mono text-xs break-all">
                  {primaryEntry.resourceId || "-"}
                </div>
              </div>
            </div>

            {group.entries.length > 1 && isExpanded && (
              <div className="space-y-3 border-t pt-4">
                {group.entries.map((entry) => (
                  <AuditTimelineEntry key={entry.id} log={entry} />
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
