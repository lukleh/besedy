"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { DeepSearchJobStatus } from "@/lib/jobs-api/schemas";

export function isActiveDeepSearchStatus(status: DeepSearchJobStatus) {
  return status === "QUEUED" || status === "RUNNING";
}

export function DeepSearchStatusBadge({
  status,
}: {
  status: DeepSearchJobStatus;
}) {
  const t = useTranslations("catalog.deepSearch.status");
  const label =
    status === "QUEUED"
      ? t("queued")
      : status === "RUNNING"
        ? t("running")
        : status === "SUCCEEDED"
          ? t("succeeded")
          : status === "FAILED"
            ? t("failed")
            : t("cancelled");
  const variant =
    status === "SUCCEEDED"
      ? "default"
      : status === "FAILED"
        ? "destructive"
        : status === "RUNNING"
          ? "secondary"
          : "outline";

  return (
    <Badge
      variant={variant}
      className={cn(
        status === "QUEUED" && "border-sky-300 text-sky-700 dark:text-sky-300",
        status === "RUNNING" && "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
        status === "CANCELLED" && "text-muted-foreground"
      )}
    >
      {label}
    </Badge>
  );
}
