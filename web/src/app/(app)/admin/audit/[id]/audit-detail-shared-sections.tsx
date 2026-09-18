"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Play,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function getInitials(name: string | null, email: string | null): string {
  if (name) {
    return name
      .split(" ")
      .map((part) => part[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }
  if (email) {
    return email.slice(0, 2).toUpperCase();
  }
  return "??";
}

interface AuditGrantDetailItem {
  catalogId: string;
  accessLevel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getGrantDetailItems(value: unknown): AuditGrantDetailItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const catalogId = getStringValue(entry.catalogId);
    const accessLevel = getStringValue(entry.accessLevel);

    if (!catalogId || !accessLevel) {
      return [];
    }

    return [{ catalogId, accessLevel }];
  });
}

function getGrantSectionTitle(
  action: string,
  sectionKey: "grants" | "reopenedGrants" | "revokedGrants"
): string {
  if (sectionKey === "reopenedGrants") {
    return "Reopened catalog grants";
  }

  if (sectionKey === "revokedGrants") {
    return "Revoked catalog grants";
  }

  return action === "PORTAL_ADMISSION_CLAIMED"
    ? "Claimed catalog grants"
    : "Catalog grants";
}

export function CopyableHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-2 font-mono text-sm">
      <span className="max-w-[200px] truncate" title={hash}>
        {hash}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-600" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </Button>
    </div>
  );
}

export function AuditGrantDetailsSummary({
  action,
  details,
}: {
  action: string;
  details: Record<string, unknown>;
}) {
  const grantSections = [
    {
      key: "grants" as const,
      title: getGrantSectionTitle(action, "grants"),
      grants: getGrantDetailItems(details.grants),
    },
    {
      key: "reopenedGrants" as const,
      title: getGrantSectionTitle(action, "reopenedGrants"),
      grants: getGrantDetailItems(details.reopenedGrants),
    },
    {
      key: "revokedGrants" as const,
      title: getGrantSectionTitle(action, "revokedGrants"),
      grants: getGrantDetailItems(details.revokedGrants),
    },
  ].filter((section) => section.grants.length > 0);

  if (grantSections.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {grantSections.map((section) => (
        <Card key={section.key} className="bg-muted/40">
          <CardContent className="pb-4 pt-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{section.title}</span>
              <Badge variant="secondary">{section.grants.length}</Badge>
            </div>
            <div className="space-y-2">
              {section.grants.map((grant) => (
                <div
                  key={`${section.key}:${grant.catalogId}:${grant.accessLevel}`}
                  className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2"
                >
                  <span className="font-mono text-xs sm:text-sm">
                    {grant.catalogId}
                  </span>
                  <Badge variant="outline">{grant.accessLevel}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function DetailsViewer({ details }: { details: Record<string, unknown> }) {
  const t = useTranslations("admin.audit.detail");
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-2">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-between"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          {t("details")}
        </span>
        {expanded ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )}
      </Button>
      {expanded && (
        <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">
          {JSON.stringify(details, null, 2)}
        </pre>
      )}
    </div>
  );
}

function parseDurationToSeconds(duration: string): number | null {
  if (!duration) return null;
  const parts = duration.split(":").map(Number);
  if (parts.length === 3 && parts.every((part) => !isNaN(part))) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2 && parts.every((part) => !isNaN(part))) {
    return parts[0] * 60 + parts[1];
  }
  return null;
}

function formatSecondsToTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${wholeSeconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${wholeSeconds.toString().padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function AudioStreamRangeInfo({
  details,
  audioDuration,
}: {
  details: Record<string, unknown>;
  audioDuration?: string;
}) {
  const t = useTranslations("admin.audit.detail");

  const rangeStart = details.rangeStart as number | undefined;
  const rangeEnd = details.rangeEnd as number | undefined;
  const fileSize = details.fileSize as number | undefined;

  if (rangeStart === undefined || fileSize === undefined) {
    return null;
  }

  const isFullFile = rangeStart === 0 && rangeEnd === fileSize - 1;
  const durationSeconds = audioDuration ? parseDurationToSeconds(audioDuration) : null;
  const seekPercent = (rangeStart / fileSize) * 100;
  const seekTime = durationSeconds ? (rangeStart / fileSize) * durationSeconds : null;

  return (
    <Card className="bg-muted/50">
      <CardContent className="pb-4 pt-4">
        <div className="mb-3 flex items-center gap-2">
          <Play className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{t("streamPosition")}</span>
        </div>

        {isFullFile ? (
          <p className="text-sm text-muted-foreground">{t("fullFileRequest")}</p>
        ) : (
          <div className="space-y-3">
            <div className="relative h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="absolute h-full rounded-full bg-primary/60"
                style={{
                  left: `${seekPercent}%`,
                  width: `${((rangeEnd! - rangeStart) / fileSize) * 100}%`,
                }}
              />
              <div
                className="absolute h-full w-1 bg-primary"
                style={{ left: `${seekPercent}%` }}
              />
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("seekPosition")}</span>
                <span className="font-mono">
                  {seekTime !== null ? formatSecondsToTime(seekTime) : `${seekPercent.toFixed(1)}%`}
                </span>
              </div>
              {audioDuration && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("totalDuration")}</span>
                  <span className="font-mono">{audioDuration}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("byteRange")}</span>
                <span className="font-mono text-xs">
                  {formatBytes(rangeStart)} - {formatBytes(rangeEnd!)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("chunkSize")}</span>
                <span className="font-mono text-xs">
                  {formatBytes(rangeEnd! - rangeStart + 1)}
                </span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
