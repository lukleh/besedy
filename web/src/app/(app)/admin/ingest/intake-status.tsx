"use client";

import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import {
  isActiveIntakeStatus,
  type RecordingIntakeDto,
  type RecordingIntakeStatus,
} from "@/lib/ingest/types";
import { IntakeProgress } from "./intake-progress";

const ICON_CLASS = "h-4 w-4 shrink-0";

function statusVariant(
  status: RecordingIntakeStatus
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "SUCCEEDED":
      return "default";
    case "FAILED":
    case "REJECTED":
      return "destructive";
    case "CANCELLED":
    case "REMOVED":
      return "outline";
    default:
      return "secondary";
  }
}

/**
 * Status badge of an intake row with an icon in front: a spinner while the
 * worker is on it, a check or an error once it is done. An active row whose
 * state could not be refreshed (the page lost the server, or the server lost
 * the jobs service) shows a warning instead of the spinner, since nothing is
 * confirming that the job still moves. The icons only repeat the badge and
 * the warning text, so screen readers skip them.
 */
export function IntakeStatus({
  intake,
  connectionLost,
}: {
  intake: RecordingIntakeDto;
  connectionLost: boolean;
}) {
  const t = useTranslations("admin.ingest");
  const active = isActiveIntakeStatus(intake.status);
  const warning = !active
    ? null
    : connectionLost
      ? t("jobs.connectionLost")
      : intake.jobStateUnavailable
        ? t("jobs.jobStateUnavailable")
        : null;

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <StatusIcon status={intake.status} warning={warning} />
        <Badge variant={statusVariant(intake.status)}>{t(`status.${intake.status}`)}</Badge>
      </div>
      {warning && (
        <div
          className="mt-1 text-xs text-amber-700 dark:text-amber-500"
          data-testid="ingest-intake-warning"
        >
          {warning}
        </div>
      )}
      <IntakeProgress intake={intake} />
    </div>
  );
}

function StatusIcon({
  status,
  warning,
}: {
  status: RecordingIntakeStatus;
  warning: string | null;
}) {
  if (warning) {
    return (
      <AlertTriangle
        className={`${ICON_CLASS} text-amber-600 dark:text-amber-500`}
        aria-hidden="true"
        data-testid="ingest-status-icon-warning"
      />
    );
  }
  if (isActiveIntakeStatus(status)) {
    return (
      <Loader2
        className={`${ICON_CLASS} animate-spin text-muted-foreground`}
        aria-hidden="true"
        data-testid="ingest-status-icon-active"
      />
    );
  }
  switch (status) {
    case "SUCCEEDED":
    case "REMOVED":
      return (
        <CheckCircle2
          className={`${ICON_CLASS} text-green-600`}
          aria-hidden="true"
          data-testid="ingest-status-icon-success"
        />
      );
    case "FAILED":
      return (
        <XCircle
          className={`${ICON_CLASS} text-destructive`}
          aria-hidden="true"
          data-testid="ingest-status-icon-failed"
        />
      );
    case "REJECTED":
      return (
        <AlertTriangle
          className={`${ICON_CLASS} text-amber-600 dark:text-amber-500`}
          aria-hidden="true"
          data-testid="ingest-status-icon-rejected"
        />
      );
    default:
      return null;
  }
}
