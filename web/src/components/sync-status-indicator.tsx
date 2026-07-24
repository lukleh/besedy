"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Cloud, CloudOff, RefreshCw, AlertCircle } from "lucide-react";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import { useCatalogStatus } from "@/hooks/use-catalog-status";
import { useCatalogContext } from "@/hooks/use-catalog-context";
import { cn } from "@/lib/utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TranslationFn = (key: string, values?: Record<string, any>) => string;

/**
 * Format a date as relative time (e.g., "2 min ago", "3 hours ago")
 */
function formatRelativeTime(date: Date | null, t: TranslationFn): string {
  if (!date) return t("neverSynced");

  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) return t("justNow");
  if (diffMinutes < 60) return t("minutesAgo", { count: diffMinutes });
  if (diffHours < 24) return t("hoursAgo", { count: diffHours });
  return t("daysAgo", { count: diffDays });
}

interface SyncStatusIndicatorProps {
  /** Optional catalogId to use directly, bypassing async context lookup */
  catalogId?: string | null;
}

/**
 * Sync status indicator for the header.
 * Shows online/offline status, sync progress, and staleness.
 * Clickable to manually trigger a full sync.
 */
export function SyncStatusIndicator({ catalogId: propCatalogId }: SyncStatusIndicatorProps) {
  const t = useTranslations("offline");
  const { isOnline } = useOnlineStatus();
  const { catalogId: contextCatalogId } = useCatalogContext();
  // Prefer prop if provided (avoids async lookup race condition)
  const catalogId = propCatalogId ?? contextCatalogId;
  const { progress, startSync, isSyncing, isComplete } = useBackgroundSync(catalogId ?? null);
  const { isStale, markAsSynced, lastSyncedAt, catalogChangedAt } = useCatalogStatus(catalogId ?? null);

  // Update cached timestamp when background sync completes
  useEffect(() => {
    if (progress?.status === "complete" && progress.lastModifiedAt) {
      markAsSynced(progress.lastModifiedAt);
    }
  }, [progress?.status, progress?.lastModifiedAt, markAsSynced]);

  // Manual sync handler - forces a full refresh
  const handleManualSync = () => {
    if (!isOnline || isSyncing || !catalogId) return;
    startSync(true); // Force refresh
  };

  const getStatusIcon = () => {
    if (!isOnline) {
      return <CloudOff className="h-5 w-5 text-muted-foreground" />;
    }
    if (progress?.status === "error") {
      return <AlertCircle className="h-5 w-5 text-muted-foreground" />;
    }
    if (isSyncing) {
      return <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />;
    }
    // Show alert icon when data may be outdated
    if (isStale) {
      return <AlertCircle className="h-5 w-5 text-muted-foreground" />;
    }
    return <Cloud className="h-5 w-5 text-muted-foreground" />;
  };

  const getShortStatusText = () => {
    if (!isOnline) {
      return t("offline");
    }
    if (progress?.status === "error") {
      return t("syncError");
    }
    if (isSyncing && progress) {
      return `${progress.currentPage}/${progress.totalPages}`;
    }
    if (isStale) {
      return t("outdated");
    }
    if (isComplete) {
      return t("synced");
    }
    return null;
  };

  // Don't show if no catalog selected
  if (!catalogId) {
    return null;
  }

  // Build detailed tooltip with timing info
  const getTooltipText = () => {
    if (!isOnline) {
      return t("offline");
    }
    if (progress?.status === "error") {
      return `${t("syncError")}: ${progress.error}`;
    }
    if (isSyncing) {
      return t("syncingProgress", {
        current: progress?.currentPage ?? 0,
        total: progress?.totalPages ?? 0,
      });
    }

    // Build timing tooltip
    const syncedTimeStr = formatRelativeTime(lastSyncedAt, t);
    const changedTimeStr = formatRelativeTime(catalogChangedAt, t);

    if (isStale) {
      return t("outdatedTooltip");
    }

    // Show sync time and catalog change time
    if (lastSyncedAt && catalogChangedAt) {
      return t("syncTooltipFull", {
        syncedTime: syncedTimeStr,
        changedTime: changedTimeStr,
      });
    }

    if (lastSyncedAt) {
      return t("lastSynced", { time: syncedTimeStr });
    }

    // If sync just completed but lastSyncedAt not yet updated, show synced state
    if (isComplete) {
      return t("synced");
    }

    return t("notSynced");
  };

  const tooltipText = getTooltipText();
  const canSync = isOnline && !isSyncing;

  // Full tooltip: timing info + click hint when available
  const fullTooltip = canSync
    ? `${tooltipText}\n${t("clickToSync")}`
    : tooltipText;

  return (
    <button
      type="button"
      onClick={handleManualSync}
      disabled={!canSync}
      className={cn(
        "flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm",
        "transition-colors",
        canSync
          ? "hover:bg-muted cursor-pointer"
          : "cursor-default opacity-70"
      )}
      title={fullTooltip}
      aria-label={fullTooltip}
    >
      {getStatusIcon()}
      <span className="hidden sm:inline text-xs text-muted-foreground">
        {getShortStatusText()}
      </span>
    </button>
  );
}
