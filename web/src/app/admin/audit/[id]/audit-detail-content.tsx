"use client";

// Owns the audit-detail page shell and data fetch. Detailed entity cards,
// JSON helpers, and stream-range views live in adjacent modules so this file
// stays focused on the page-level loading and composition flow.

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import {
  ArrowLeft,
  Clock,
  Globe,
  Loader2,
  Monitor,
  Target,
} from "lucide-react";
import { formatLocalDate } from "@/lib/date-format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import {
  formatActionLabel,
  formatDomainLabel,
  getActionBadgeVariant,
  getOutcomeBadgeVariant,
} from "../utils";
import {
  AudioStreamRangeInfo,
  AuditGrantDetailsSummary,
  CopyableHash,
  DetailsViewer,
  getInitials,
  RelatedEntitySection,
} from "./audit-detail-sections";
import type { AuditLogDetail, RelatedAudio } from "./audit-detail-types";

export default function AuditDetailContent() {
  const params = useParams();
  const t = useTranslations("admin.audit");
  const locale = useLocale();
  const logId = params.id as string;

  const {
    data: log,
    isLoading,
    error,
  } = useQuery<AuditLogDetail>({
    queryKey: ["admin-audit-detail", logId],
    queryFn: async () => {
      try {
        return await fetchJson<AuditLogDetail>(`/api/admin/audit/${logId}?expand=true`);
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 404) throw new Error("Audit log not found");
          if (error.status === 403) throw new Error("Access denied");
        }
        throw error;
      }
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !log) {
    return (
      <div className="space-y-4">
        <Link
          href="/admin/audit"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("detail.backToList")}
        </Link>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">
              {error?.message || t("detail.notFound")}
            </p>
            <Button variant="outline" className="mt-4" asChild>
              <Link href="/admin/audit">{t("detail.returnToList")}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const actorLabel =
    log.actor?.label ??
    log.user?.name ??
    log.user?.email ??
    log.userId ??
    t("system");
  const actorSecondary =
    log.actor?.secondaryLabel ??
    (log.user?.name && log.user?.email ? log.user.email : null);
  const rawDetails = log.rawDetails ?? log.details;
  const domain = log.domain || "unknown";
  const outcome = log.outcome || "info";
  const hasPayloadDetails = Boolean(log.details && Object.keys(log.details).length > 0);
  const hasRawDetails = Boolean(rawDetails && Object.keys(rawDetails).length > 0);

  return (
    <div className="space-y-6">
      <Link
        href="/admin/audit"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("detail.backToList")}
      </Link>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={getActionBadgeVariant(log.action)} className="text-sm">
                {formatActionLabel(log.action)}
              </Badge>
              <Badge variant={getOutcomeBadgeVariant(outcome)}>
                {outcome}
              </Badge>
              <Badge variant="outline">{formatDomainLabel(domain)}</Badge>
            </div>

            <h1 className="text-2xl font-semibold leading-tight">
              {log.summary || formatActionLabel(log.action)}
            </h1>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                {formatLocalDate(log.createdAt, locale, "MMM d, yyyy HH:mm:ss")}
              </span>
              <span className="text-sm text-muted-foreground">•</span>
              <span className="flex items-center gap-2 text-sm">
                <Avatar className="h-5 w-5">
                  <AvatarImage src={log.actor?.image || log.user?.image || undefined} />
                  <AvatarFallback className="text-[10px]">
                    {getInitials(log.user?.name ?? null, log.user?.email ?? actorLabel)}
                  </AvatarFallback>
                </Avatar>
                <span className="font-medium text-foreground">{actorLabel}</span>
                {actorSecondary && (
                  <span className="hidden sm:inline">({actorSecondary})</span>
                )}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 border-t py-4 md:grid-cols-2">
            <div className="rounded-lg border bg-muted/30 p-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Actor
              </div>
              <div className="font-medium">{actorLabel}</div>
              {actorSecondary && (
                <div className="text-sm text-muted-foreground">{actorSecondary}</div>
              )}
            </div>

            <div className="rounded-lg border bg-muted/30 p-4">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Target className="h-3.5 w-3.5" />
                Target
              </div>
              <div className="font-medium">
                {log.target?.label || log.resourceId || log.resource}
              </div>
              {(log.target?.secondaryLabel || log.target?.catalogLabel) && (
                <div className="text-sm text-muted-foreground">
                  {log.target?.secondaryLabel || log.target?.catalogLabel}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 border-t py-3 text-sm sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-muted-foreground">{t("detail.resource")}</span>
              <span className="font-medium">{log.resource}</span>
            </div>
            <div className="flex items-center gap-2">
              <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="w-20 shrink-0 text-muted-foreground">{t("detail.ipAddress")}</span>
              <span className="font-mono text-xs">{log.ipAddress || "-"}</span>
            </div>
            {log.resourceId && (
              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-muted-foreground">{t("detail.resourceId")}</span>
                <CopyableHash hash={log.resourceId} />
              </div>
            )}
            {log.target?.catalogId && (
              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-muted-foreground">{t("detail.catalogId")}</span>
                <span className="font-mono text-xs">{log.target.catalogId}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Monitor className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="w-20 shrink-0 text-muted-foreground">{t("detail.userAgent")}</span>
              <span className="truncate text-xs" title={log.userAgent || undefined}>
                {log.userAgent || "-"}
              </span>
            </div>
          </div>

          {(hasPayloadDetails || hasRawDetails) && (
            <div className="space-y-3 border-t pt-2">
              {hasPayloadDetails && log.details && (
                <AuditGrantDetailsSummary
                  action={log.action}
                  details={log.details}
                />
              )}
              {rawDetails && <DetailsViewer details={rawDetails} />}
            </div>
          )}
        </CardContent>
      </Card>

      {log.action === "AUDIO_STREAMED" && log.details && (
        <AudioStreamRangeInfo
          details={log.details}
          audioDuration={
            log.relatedEntity?.type === "audio" && log.relatedEntity.found
              ? (log.relatedEntity.data as RelatedAudio)?.entry?.duration_hms
              : undefined
          }
        />
      )}

      {log.relatedEntity && (
        <RelatedEntitySection
          entity={log.relatedEntity}
          resourceId={log.resourceId}
        />
      )}
    </div>
  );
}
