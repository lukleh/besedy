"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DeepSearchAction,
  DeepSearchIconAction,
} from "@/components/catalog/deep-search-action";
import {
  EditModeToolbar,
  UnsavedChangesDialog,
} from "../inline-edit";
import type { CatalogListProps } from "./types";
import { useCatalogListController } from "./hooks";
import {
  CatalogSkeleton,
  CatalogNotFoundState,
  CatalogErrorState,
  CatalogEmptyState,
  NoMatchState,
  CatalogPagination,
  DesktopCatalogTable,
  MobileCardView,
  Toolbar,
  MobileFilterChips,
  MobileSearchOverlay,
  RagSearchBar,
  RagSearchResults,
} from "./components";

const NotificationPromptBanner = dynamic(
  () => import("@/components/notifications/notification-prompt-banner").then((module) => module.NotificationPromptBanner),
  { ssr: false }
);

export function CatalogList({ catalogId, deepSearchHref }: CatalogListProps) {
  const controller = useCatalogListController({ catalogId });
  const t = useTranslations("catalog");
  const deepSearchLabel = t("deepSearch.label");

  if (controller.status === "loading") {
    return <CatalogSkeleton catalogName={controller.catalogName} />;
  }

  if (controller.status === "not-found") {
    return <CatalogNotFoundState catalogId={controller.catalogId} />;
  }

  if (controller.status === "error") {
    return <CatalogErrorState error={controller.error} />;
  }

  if (controller.status === "idle") {
    return null;
  }

  if (controller.status === "empty") {
    return <CatalogEmptyState />;
  }

  return (
    <div
      className={cn(
        "@container/catalog space-y-4 transition-opacity duration-200",
        controller.isFetching && "opacity-60"
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <h1 className="shrink-0 text-2xl font-bold tracking-tight">
          {controller.title}
        </h1>
        <div className="flex items-center gap-4">
          <span className="whitespace-nowrap text-sm">{controller.countLabel}</span>
          {controller.canUseRagSearch && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="@[768px]/catalog:hidden landscape-mobile:inline-flex"
              onClick={controller.openMobileSearchOverlay}
              aria-label={controller.mobileRagSearchLabel}
              data-testid="mobile-rag-search-button"
            >
              <Search className="h-4 w-4" />
            </Button>
          )}
          {deepSearchHref ? (
            <DeepSearchIconAction
              href={deepSearchHref}
              label={deepSearchLabel}
              className="@[768px]/catalog:hidden landscape-mobile:inline-flex"
            />
          ) : null}
          <Toolbar {...controller.toolbarProps} />
        </div>
      </div>

      <NotificationPromptBanner />

      {(controller.desktopRagSearchProps || deepSearchHref) && (
        <div className="hidden items-stretch gap-3 @[768px]/catalog:flex landscape-mobile:hidden">
          {controller.desktopRagSearchProps ? (
            <div className="min-w-0 flex-1">
              <RagSearchBar {...controller.desktopRagSearchProps} />
            </div>
          ) : null}
          {deepSearchHref ? (
            <DeepSearchAction href={deepSearchHref} label={deepSearchLabel} />
          ) : null}
        </div>
      )}

      {controller.ragResultsProps && (
        <div className="hidden space-y-3 @[768px]/catalog:block landscape-mobile:hidden">
          <span className="text-sm" aria-live="polite">
            {controller.ragResultsCountLabel}
          </span>
          <RagSearchResults {...controller.ragResultsProps} />
        </div>
      )}

      {controller.showMobileNoMatch && (
        <NoMatchState
          onClearFilters={controller.clearFilters}
          className="flex flex-col items-center gap-2 py-12 @[768px]/catalog:hidden landscape-mobile:flex"
        />
      )}

      <MobileFilterChips {...controller.mobileFilterChipsProps} />
      <MobileCardView {...controller.mobileCardViewProps} />

      {controller.mobileSearchOverlayProps && (
        <MobileSearchOverlay {...controller.mobileSearchOverlayProps} />
      )}

      {controller.desktopTableProps && (
        <DesktopCatalogTable {...controller.desktopTableProps} />
      )}

      {controller.paginationProps && (
        <CatalogPagination {...controller.paginationProps} />
      )}

      {controller.editModeToolbarProps && (
        <EditModeToolbar {...controller.editModeToolbarProps} />
      )}

      <UnsavedChangesDialog {...controller.unsavedChangesDialogProps} />
    </div>
  );
}
