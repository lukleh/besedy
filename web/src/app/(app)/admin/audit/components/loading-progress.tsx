"use client";

import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import type { LoadingProgress } from "../hooks/use-audit-load-more";

interface LoadingProgressDisplayProps {
  progress: LoadingProgress;
  isLoadMore?: boolean;
}

export function LoadingProgressDisplay({
  progress,
  isLoadMore = false,
}: LoadingProgressDisplayProps) {
  const t = useTranslations("admin.audit");

  // Calculate percentages for progress bars
  const entriesPercent =
    progress.totalEntries > 0
      ? Math.min(100, (progress.loadedEntries / progress.totalEntries) * 100)
      : 0;

  const groupsPercent = Math.min(
    100,
    (progress.groupsFormed / progress.targetGroups) * 100
  );

  return (
    <div className="flex flex-col items-center justify-center py-12 space-y-6">
      {/* Spinner */}
      <div className="relative">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs font-medium">{progress.batchesFetched}</span>
        </div>
      </div>

      {/* Status text */}
      <div className="text-center space-y-1">
        <p className="text-sm font-medium">
          {isLoadMore ? t("progress.loadingMore") : t("progress.loading")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("progress.batch", { count: progress.batchesFetched })}
        </p>
      </div>

      {/* Progress bars */}
      <div className="w-full max-w-xs space-y-4">
        {/* Entries progress */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{t("progress.entries")}</span>
            <span>
              {progress.loadedEntries.toLocaleString()}
              {progress.totalEntries > 0 && (
                <span> / {progress.totalEntries.toLocaleString()}</span>
              )}
            </span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary/60 rounded-full transition-all duration-300"
              style={{ width: `${entriesPercent}%` }}
            />
          </div>
        </div>

        {/* Groups progress */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{t("progress.groups")}</span>
            <span>
              {progress.groupsFormed} / {progress.targetGroups}
            </span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${groupsPercent}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
