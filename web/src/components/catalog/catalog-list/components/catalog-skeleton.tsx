"use client";

import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface CatalogSkeletonProps {
  catalogName?: string;
}

export function CatalogSkeleton({ catalogName }: CatalogSkeletonProps) {
  const t = useTranslations("catalog");
  return (
    <div className="space-y-4">
      {/* Filter bar skeleton */}
      <div className="flex flex-wrap items-end gap-3">
        <Skeleton className="h-9 w-[220px]" />
        <Skeleton className="h-9 w-[200px]" />
        <Skeleton className="h-9 w-[140px]" />
        <Skeleton className="h-9 w-[140px]" />
        <Skeleton className="h-9 w-[100px] ml-auto" />
      </div>

      {/* Stats skeleton */}
      <Skeleton className="h-5 w-64" />

      {/* Table skeleton */}
      <div className="rounded-md border">
        <div className="h-12 border-b bg-muted/50" />
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center gap-4 p-4 border-b last:border-0">
            <Skeleton className="h-5 w-[35%]" />
            <Skeleton className="h-5 w-[20%]" />
            <Skeleton className="h-5 w-[15%]" />
            <Skeleton className="h-5 w-[20%]" />
          </div>
        ))}
      </div>

      {/* Loading message */}
      <div className="flex flex-col items-center justify-center py-4 text-center">
        <Loader2 className="h-6 w-6 text-muted-foreground mb-2 animate-spin" />
        <p className="text-sm text-muted-foreground">
          {catalogName
            ? t("loadingCatalogName", { name: catalogName })
            : t("loading")}
        </p>
      </div>
    </div>
  );
}
