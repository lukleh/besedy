"use client";

import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Plus, ChevronsRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PaginationInfo } from "../types";

interface CatalogPaginationProps {
  pagination: PaginationInfo;
  onPageChange: (page: number) => void;
  onLoadNext?: () => void;
  onLoadAll?: () => void;
  isLoadingNext?: boolean;
  isLoadingAll?: boolean;
  isLoadMoreMode?: boolean;
  loadedCount?: number;
  totalCount?: number;
  hasMoreToLoad?: boolean;
}

export function CatalogPagination({
  pagination,
  onPageChange,
  onLoadNext,
  onLoadAll,
  isLoadingNext = false,
  isLoadingAll = false,
  isLoadMoreMode = false,
  loadedCount,
  totalCount,
  hasMoreToLoad = false,
}: CatalogPaginationProps) {
  const t = useTranslations("catalog");

  if (pagination.totalPages <= 1) {
    return null;
  }

  const showLoadMoreButtons = onLoadNext && onLoadAll;
  const isLoading = isLoadingNext || isLoadingAll;

  return (
    <div className="flex flex-col items-center gap-3 pt-4">
      {/* Page info */}
      <p className="text-sm text-muted-foreground">
        {isLoadMoreMode && loadedCount !== undefined && totalCount !== undefined
          ? t("pagination.showing", { count: loadedCount, total: totalCount })
          : t("pagination.page", { page: pagination.page, total: pagination.totalPages })}
      </p>

      {/* Previous / Next buttons */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(pagination.page - 1)}
          disabled={!pagination.hasPrevPage || isLoading}
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          {t("pagination.previous")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(pagination.page + 1)}
          disabled={!pagination.hasNextPage || isLoading}
        >
          {t("pagination.next")}
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>

      {/* Load More / Load All buttons */}
      {showLoadMoreButtons && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadNext}
            disabled={!hasMoreToLoad || isLoading}
          >
            {isLoadingNext ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-1" />
            )}
            {t("pagination.loadNext")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadAll}
            disabled={!hasMoreToLoad || isLoading}
          >
            {isLoadingAll ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <ChevronsRight className="h-4 w-4 mr-1" />
            )}
            {t("pagination.loadAll")}
          </Button>
        </div>
      )}
    </div>
  );
}
