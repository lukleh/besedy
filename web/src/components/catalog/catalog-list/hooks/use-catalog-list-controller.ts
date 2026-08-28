"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useToast } from "@/hooks/use-toast";
import { isAccessDeniedError } from "@/lib/query/auth-sensitive";
import { useCatalogContext } from "@/hooks/use-catalog-context";
import { useFilterOptions, type CatalogFilters, type FilterOptionsResponse } from "@/hooks/use-filter-options";
import { useRecorders, useLocations, useAlbums } from "@/hooks/use-metadata-enums";
import { useIsDesktop } from "@/hooks/use-media-query";
import { useColumnResize, type ColumnKey as ResizeColumnKey } from "@/hooks/use-column-resize";
import { useCatalogStatus } from "@/hooks/use-catalog-status";
import { useReloadBlocker } from "@/contexts/reload-safety-context";
import {
  useInlineEdit,
  type UseInlineEditReturn,
} from "@/components/catalog/inline-edit";
import type { CatalogListProps, ColumnKey } from "../types";
import { includeSelectedNamedOption } from "../utils";
import { useCatalogFilters, type UseCatalogFiltersReturn } from "./use-catalog-filters";
import { useColumnVisibility } from "./use-column-visibility";
import { useCatalogData } from "./use-catalog-data";
import { useLoadMore } from "./use-load-more";
import { usePublicationState } from "./use-publication-state";
import {
  useRagSearch,
  type RagSearchResult,
} from "./use-rag-search";
import { useUrlFilterSync } from "./use-url-filter-sync";

const DEFAULT_COLUMN_VISIBILITY: Record<ColumnKey, boolean> = {
  title: true,
  date: true,
  part: true,
  recorder: true,
  location: true,
  duration: false,
  artist: false,
  album: false,
  status: true,
  verified: false,
  duplicates: false,
  offline: true,
};

function resolveCatalogName(
  activeGroup: { label?: string | null; id?: string | null } | null | undefined,
  catalogId: string | undefined
) {
  return activeGroup?.label || activeGroup?.id || catalogId;
}

function getFilterOptionLists(filterOptions: FilterOptionsResponse | undefined) {
  return {
    recorders: filterOptions?.options.recorders ?? [],
    locations: filterOptions?.options.locations ?? [],
    artists: filterOptions?.options.artists ?? [],
    albums: filterOptions?.options.albums ?? [],
    duplicateCounts: filterOptions?.options.duplicates ?? [],
    availableParts: filterOptions?.options.parts ?? [],
    availableYears: filterOptions?.options.years ?? [],
    availableMonths: filterOptions?.options.months ?? [],
    availableStatuses: filterOptions?.options.statuses ?? [],
    availableDurations: filterOptions?.options.durations ?? [],
    availableVerified: filterOptions?.options.verified ?? [],
  };
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

type CatalogListStatus = "idle" | "loading" | "not-found" | "error" | "empty" | "ready";

interface CatalogListControllerBase {
  status: CatalogListStatus;
}

interface CatalogListControllerLoading extends CatalogListControllerBase {
  status: "loading";
  catalogName: string | undefined;
}

interface CatalogListControllerNotFound extends CatalogListControllerBase {
  status: "not-found";
  catalogId: string | undefined;
}

interface CatalogListControllerError extends CatalogListControllerBase {
  status: "error";
  error: Error;
}

interface CatalogListControllerEmpty extends CatalogListControllerBase {
  status: "empty";
}

interface CatalogListControllerIdle extends CatalogListControllerBase {
  status: "idle";
}

interface CatalogListControllerReady extends CatalogListControllerBase {
  status: "ready";
  title: string;
  mobileRagSearchLabel: string;
  ragResultsCountLabel: string;
  isFetching: boolean;
  countLabel: string;
  canUseRagSearch: boolean;
  openMobileSearchOverlay: () => void;
  showMobileNoMatch: boolean;
  clearFilters: () => void;
  toolbarProps: {
    hasActiveFilters: boolean;
    canBatchEditMetadata: boolean;
    isEditMode: boolean;
    onToggleEditMode: () => void;
    columnVisibility: Record<ColumnKey, boolean>;
    toggleColumn: (key: ColumnKey) => void;
    resetColumns: () => void;
    hasNonDefaultColumns: boolean;
    resetColumnWidths: () => void;
    clearFilters: () => void;
  };
  desktopRagSearchProps: null | {
    ragQuery: string;
    setRagQuery: (value: string) => void;
    isRagMode: boolean;
    ragLoading: boolean;
    onSubmit: ReturnType<typeof useRagSearch>["handleRagSubmit"];
    onBack: () => void;
    onClear: () => void;
  };
  ragResultsProps: null | {
    results: RagSearchResult[];
    loading: boolean;
    error: string | null;
    onRetry: () => void;
    onOpenResult: (result: RagSearchResult) => void;
  };
  mobileFilterChipsProps: {
    dateYear: string;
    handleDateYearChange: (value: string) => void;
    locationFilter: string;
    setLocationFilter: (value: string) => void;
    filterOptions: FilterOptionsResponse | undefined;
    hasActiveFilters: boolean;
    clearFilters: () => void;
  };
  mobileCardViewProps: {
    entries: ReturnType<typeof useLoadMore>["displayEntries"];
    groupId: string;
  };
  mobileSearchOverlayProps: null | {
    open: boolean;
    ragQuery: string;
    ragSubmittedQuery: string;
    ragResults: RagSearchResult[];
    ragLoading: boolean;
    ragError: string | null;
    setRagQuery: (value: string) => void;
    onSubmit: ReturnType<typeof useRagSearch>["handleRagSubmit"];
    onRetry: () => void;
    onOpenResult: (result: RagSearchResult) => void;
    onClear: () => void;
    onClose: () => void;
  };
  desktopTableProps: null | {
    activeCatalogId: string | null | undefined;
    albums: ReturnType<typeof getFilterOptionLists>["albums"];
    allAlbums: NonNullable<ReturnType<typeof useAlbums>["data"]>;
    allLocations: NonNullable<ReturnType<typeof useLocations>["data"]>;
    allRecorders: NonNullable<ReturnType<typeof useRecorders>["data"]>;
    artists: ReturnType<typeof getFilterOptionLists>["artists"];
    availableDurations: ReturnType<typeof getFilterOptionLists>["availableDurations"];
    availableMonths: ReturnType<typeof getFilterOptionLists>["availableMonths"];
    availableParts: ReturnType<typeof getFilterOptionLists>["availableParts"];
    availableStatuses: ReturnType<typeof getFilterOptionLists>["availableStatuses"];
    availableVerified: ReturnType<typeof getFilterOptionLists>["availableVerified"];
    availableYears: ReturnType<typeof getFilterOptionLists>["availableYears"];
    canManageAccess: boolean | undefined;
    columnResize: ReturnType<typeof useColumnResize>;
    columnVisibility: Record<ColumnKey, boolean>;
    duplicateCounts: ReturnType<typeof getFilterOptionLists>["duplicateCounts"];
    entries: ReturnType<typeof useLoadMore>["displayEntries"];
    filters: UseCatalogFiltersReturn;
    hasDuplicateCounts: boolean;
    hasDurations: boolean;
    hasStatuses: boolean;
    hasVerifiedOptions: boolean;
    inlineEdit: UseInlineEditReturn;
    lastVisibleColumnKey: ColumnKey | undefined;
    locations: ReturnType<typeof getFilterOptionLists>["locations"];
    onOpenRecording: (hash: string) => void;
    onTogglePublication: (hash: string, isPublished: boolean) => Promise<void>;
    publishingHashes: Set<string>;
    recorders: ReturnType<typeof getFilterOptionLists>["recorders"];
    visibleColumnKeys: ColumnKey[];
  };
  paginationProps: null | {
    pagination: NonNullable<ReturnType<typeof useCatalogData>["data"]>["pagination"];
    onPageChange: (page: number) => void;
    onLoadNext: () => Promise<void>;
    onLoadAll: () => Promise<void>;
    isLoadingNext: boolean;
    isLoadingAll: boolean;
    isLoadMoreMode: boolean;
    loadedCount: number;
    totalCount: number;
    hasMoreToLoad: boolean;
  };
  editModeToolbarProps: null | {
    modifiedCount: number;
    isSaving: boolean;
    onSave: () => void;
    onDiscard: () => void;
  };
  unsavedChangesDialogProps: {
    open: boolean;
    modifiedCount: number;
    onDiscard: () => void;
    onCancel: () => void;
    onSave: () => void;
    isSaving: boolean;
  };
}

export type CatalogListController =
  | CatalogListControllerIdle
  | CatalogListControllerLoading
  | CatalogListControllerNotFound
  | CatalogListControllerError
  | CatalogListControllerEmpty
  | CatalogListControllerReady;

export function useCatalogListController({
  catalogId,
}: CatalogListProps): CatalogListController {
  const t = useTranslations("catalog");
  const tInlineEdit = useTranslations("catalog.inlineEdit");
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isDesktop = useIsDesktop();

  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false);
  const [accessLevel, setAccessLevel] = useState<string | undefined>(undefined);
  const [canManageAccess, setCanManageAccess] = useState<boolean | undefined>(undefined);

  const {
    catalogId: activeCatalogId,
    activeGroup,
    groupKey,
    isLoading: loadingPreferences,
    catalogNotFound,
    catalogValidationLoading,
  } = useCatalogContext(catalogId);

  const [columnVisibilityState, setColumnVisibilityState] = useState<Record<ColumnKey, boolean>>(
    () => DEFAULT_COLUMN_VISIBILITY
  );

  const filters = useCatalogFilters({
    catalogId,
    activeCatalogId,
    isHydrated,
    columnVisibility: columnVisibilityState,
  });

  const {
    filtersReady,
    setRecorderFilter,
    setLocationFilter,
    setAlbumFilter,
    dateMonth,
    dateDay,
    setDateMonth,
    setDateDay,
  } = filters;

  const searchKey = searchParams.toString();
  const { urlFilterValuesRef } = useUrlFilterSync({
    searchKey,
    filtersReady,
    setRecorderFilter,
    setLocationFilter,
    setAlbumFilter,
  });

  const columnVisibility = useColumnVisibility({
    isHydrated,
    onFilterClear: filters.clearFilterForColumn,
    clearFilters: filters.clearFilters,
    accessLevel,
    canManageAccess,
  });

  const visibleColumnKeys = useMemo(
    () => columnVisibility.visibleColumnKeys,
    [columnVisibility.visibleColumnKeys]
  );

  useEffect(() => {
    setColumnVisibilityState(columnVisibility.columnVisibility);
  }, [columnVisibility.columnVisibility]);

  const currentFilters: CatalogFilters = useMemo(
    () => ({
      status: filters.statusFilter,
      duration: filters.durationFilter,
      verified: filters.verifiedFilter,
      recorder: filters.recorderFilter,
      location: filters.locationFilter,
      part: filters.partFilter,
      dateYear: filters.dateYear,
      dateMonth: filters.dateMonth,
      dateDay: filters.dateDay,
      artist: filters.artistFilter,
      album: filters.albumFilter,
      duplicates: filters.duplicatesFilter,
    }),
    [
      filters.statusFilter,
      filters.durationFilter,
      filters.verifiedFilter,
      filters.recorderFilter,
      filters.locationFilter,
      filters.partFilter,
      filters.dateYear,
      filters.dateMonth,
      filters.dateDay,
      filters.artistFilter,
      filters.albumFilter,
      filters.duplicatesFilter,
    ]
  );

  const { data: filterOptions, error: filterOptionsError } = useFilterOptions({
    groupId: activeCatalogId ?? undefined,
    filters: currentFilters,
    enabled: !catalogNotFound && !catalogValidationLoading,
  });

  const filterOptionsAccessDenied = isAccessDeniedError(filterOptionsError);

  const { publishingHashes, handleTogglePublication } = usePublicationState({
    activeCatalogId,
    onSuccess: (isPublished) => {
      toast({
        title: isPublished ? t("status.published") : t("status.unpublished"),
        description: isPublished
          ? t("status.publishSuccess")
          : t("status.unpublishSuccess"),
      });
    },
    onError: (error) => {
      toast({
        title: t("errorTitle"),
        description: error instanceof Error ? error.message : t("errorDescription"),
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    const urlFilters = urlFilterValuesRef.current;
    const skipInvalid = urlFilters
      ? {
          recorder: !!urlFilters.recorder && urlFilters.recorder === filters.recorderFilter,
          location: !!urlFilters.location && urlFilters.location === filters.locationFilter,
          album: !!urlFilters.album && urlFilters.album === filters.albumFilter,
        }
      : undefined;
    filters.syncWithAvailableOptions(filterOptions, skipInvalid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterOptions]);

  const { data: allRecorders = [] } = useRecorders();
  const { data: allLocations = [] } = useLocations();
  const { data: allAlbums = [] } = useAlbums();

  const { data, isLoading, isFetching, error, dataUpdatedAt } = useCatalogData({
    groupKey,
    activeCatalogId,
    statusFilter: filters.statusFilter,
    durationFilter: filters.durationFilter,
    verifiedFilter: filters.verifiedFilter,
    recorderFilter: filters.recorderFilter,
    locationFilter: filters.locationFilter,
    partFilter: filters.partFilter,
    dateYear: filters.dateYear,
    dateMonth: filters.dateMonth,
    dateDay: filters.dateDay,
    artistFilter: filters.artistFilter,
    albumFilter: filters.albumFilter,
    duplicatesFilter: filters.duplicatesFilter,
    sortKey: filters.sortKey,
    sortDir: filters.sortDir,
    page: filters.page,
    visibleColumnKeys,
    enabled:
      !catalogNotFound &&
      !catalogValidationLoading &&
      (!!activeCatalogId || !loadingPreferences) &&
      filtersReady,
  });

  const loadMore = useLoadMore({
    activeCatalogId,
    statusFilter: filters.statusFilter,
    durationFilter: filters.durationFilter,
    verifiedFilter: filters.verifiedFilter,
    recorderFilter: filters.recorderFilter,
    locationFilter: filters.locationFilter,
    partFilter: filters.partFilter,
    dateYear: filters.dateYear,
    dateMonth: filters.dateMonth,
    dateDay: filters.dateDay,
    artistFilter: filters.artistFilter,
    albumFilter: filters.albumFilter,
    duplicatesFilter: filters.duplicatesFilter,
    sortKey: filters.sortKey,
    sortDir: filters.sortDir,
    currentPage: filters.page,
    currentEntries: data?.entries ?? [],
    pagination: data?.pagination,
    baseDataUpdatedAt: dataUpdatedAt,
  });

  useEffect(() => {
    if (loadMore.error) {
      toast({ title: loadMore.error, variant: "destructive" });
    }
  }, [loadMore.error, toast]);

  useEffect(() => {
    if (data?.accessLevel) {
      setAccessLevel(data.accessLevel);
    }
    if (typeof data?.canManageAccess === "boolean") {
      setCanManageAccess(data.canManageAccess);
    }
  }, [data?.accessLevel, data?.canManageAccess]);

  const canUseRagSearch = data?.canUseRagSearch ?? false;

  const handleRagSessionRestore = useCallback(() => {
    if (!isDesktop) {
      setSearchOverlayOpen(true);
    }
  }, [isDesktop]);

  const rag = useRagSearch({
    activeCatalogId: activeCatalogId ?? null,
    canUseRagSearch,
    dataLoaded: !!data,
    onSessionRestore: handleRagSessionRestore,
  });

  useEffect(() => {
    if (isDesktop && searchOverlayOpen) {
      setSearchOverlayOpen(false);
    }
  }, [isDesktop, searchOverlayOpen]);

  useEffect(() => {
    if (isDesktop || !filtersReady) return;
    if (dateMonth === "all" && dateDay === "all") return;
    setDateMonth("all");
    setDateDay("all");
  }, [
    isDesktop,
    filtersReady,
    dateMonth,
    dateDay,
    setDateMonth,
    setDateDay,
  ]);

  const openMobileSearchOverlay = useCallback(() => {
    if (!canUseRagSearch) return;
    setSearchOverlayOpen(true);
  }, [canUseRagSearch]);

  const closeMobileSearchOverlay = useCallback(() => {
    setSearchOverlayOpen(false);
    rag.hideRagMode();
  }, [rag]);

  useEffect(() => {
    if (data?.pagination?.totalPages !== undefined) {
      filters.resetPageIfInvalid(data.pagination.totalPages);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.pagination?.totalPages, filters.resetPageIfInvalid]);

  const { markAsSynced } = useCatalogStatus(activeCatalogId ?? null);

  useEffect(() => {
    if (data?.lastModifiedAt) {
      markAsSynced(data.lastModifiedAt);
    }
  }, [data?.lastModifiedAt, markAsSynced]);

  const inlineEdit = useInlineEdit({
    catalogId: activeCatalogId ?? "",
    onSaveSuccess: () => {
      toast({
        title: tInlineEdit("saveSuccess"),
        description: tInlineEdit("saveSuccessDescription"),
      });
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
    },
    onSaveError: (errors) => {
      toast({
        title: tInlineEdit("saveError"),
        description: tInlineEdit("saveErrorDescription", { count: errors.length }),
        variant: "destructive",
      });
    },
  });

  useReloadBlocker(
    {
      id: `catalog-inline-edit:${activeCatalogId ?? "unknown"}`,
      kind: "unsaved-changes",
      blocksAutomatic: true,
      blocksManual: true,
    },
    inlineEdit.hasUnsavedChanges
  );
  useReloadBlocker(
    {
      id: `catalog-inline-save:${activeCatalogId ?? "unknown"}`,
      kind: "critical-mutation",
      blocksAutomatic: true,
      blocksManual: true,
    },
    inlineEdit.isSaving
  );

  const columnResize = useColumnResize(visibleColumnKeys as ResizeColumnKey[]);

  useEffect(() => {
    if (!inlineEdit.hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [inlineEdit.hasUnsavedChanges]);

  const openRagResult = useCallback(
    (result: RagSearchResult) => {
      if (!activeCatalogId) return;
      if (inlineEdit.isEditMode || inlineEdit.hasUnsavedChanges) {
        toast({
          title: tInlineEdit("unsavedDialogTitle"),
          description: tInlineEdit("unsavedDialogDescription", {
            count: inlineEdit.modifiedCount,
          }),
          variant: "destructive",
        });
        return;
      }

      const seek = result.startSec ?? 0;
      const end = result.endSec;
      router.push(
        `/catalog/${activeCatalogId}/recording/${result.audioHash}?seek=${encodeURIComponent(
          String(seek)
        )}${end > seek ? `&end=${encodeURIComponent(String(end))}` : ""}&fromSearch=1`
      );
    },
    [
      activeCatalogId,
      inlineEdit.hasUnsavedChanges,
      inlineEdit.isEditMode,
      inlineEdit.modifiedCount,
      router,
      tInlineEdit,
      toast,
    ]
  );

  const {
    recorders: baseRecorders,
    locations: baseLocations,
    artists,
    albums: baseAlbums,
    duplicateCounts,
    availableParts,
    availableYears,
    availableMonths,
    availableStatuses,
    availableDurations,
    availableVerified,
  } = useMemo(() => getFilterOptionLists(filterOptions), [filterOptions]);

  const recorders = useMemo(
    () => includeSelectedNamedOption(baseRecorders, allRecorders, filters.recorderFilter),
    [allRecorders, baseRecorders, filters.recorderFilter]
  );

  const locations = useMemo(
    () => includeSelectedNamedOption(baseLocations, allLocations, filters.locationFilter),
    [allLocations, baseLocations, filters.locationFilter]
  );

  const albums = useMemo(
    () => includeSelectedNamedOption(baseAlbums, allAlbums, filters.albumFilter),
    [allAlbums, baseAlbums, filters.albumFilter]
  );

  const entries = loadMore.displayEntries;
  const totalAll = data?.totalAll ?? data?.total ?? 0;

  const handleMobileDateYearChange = useCallback(
    (value: string) => {
      filters.handleDateYearChange(value);
      setDateMonth("all");
      setDateDay("all");
    },
    [filters, setDateMonth, setDateDay]
  );

  const catalogName = resolveCatalogName(activeGroup, catalogId);

  if (catalogValidationLoading || loadingPreferences || isLoading) {
    return {
      status: "loading",
      catalogName,
    };
  }

  if (catalogNotFound) {
    return {
      status: "not-found",
      catalogId,
    };
  }

  if (filterOptionsAccessDenied) {
    return {
      status: "error",
      error: toError(filterOptionsError, t("errorDescription")),
    };
  }

  if (error) {
    return {
      status: "error",
      error: toError(error, t("errorDescription")),
    };
  }

  if (!data) {
    return {
      status: "idle",
    };
  }

  if (totalAll === 0) {
    return {
      status: "empty",
    };
  }

  const hasDuplicateCounts = duplicateCounts.length > 0;
  const hasStatuses = availableStatuses.length > 0;
  const hasDurations = availableDurations.length > 0;
  const hasVerifiedOptions = availableVerified.length > 0;
  const columnVisibilityStateReady = columnVisibility.columnVisibility;
  const lastVisibleColumnKey = visibleColumnKeys[visibleColumnKeys.length - 1];
  const countLabel = filters.hasActiveFilters
    ? t("countFiltered", { filtered: data.total, total: totalAll })
    : t("count", { count: totalAll });

  return {
    status: "ready",
    title: t("title"),
    mobileRagSearchLabel: t("ragSearch.placeholder"),
    ragResultsCountLabel: t("ragSearch.resultsCount", { count: rag.ragResults.length }),
    isFetching,
    countLabel,
    canUseRagSearch,
    openMobileSearchOverlay,
    showMobileNoMatch: entries.length === 0 && filters.hasActiveFilters,
    clearFilters: filters.clearFilters,
    toolbarProps: {
      hasActiveFilters: filters.hasActiveFilters,
      canBatchEditMetadata: data.canBatchEditMetadata ?? false,
      isEditMode: inlineEdit.isEditMode,
      onToggleEditMode: inlineEdit.toggleEditMode,
      columnVisibility: columnVisibilityStateReady,
      toggleColumn: columnVisibility.toggleColumn,
      resetColumns: columnVisibility.resetColumns,
      hasNonDefaultColumns: columnVisibility.hasNonDefaultColumns,
      resetColumnWidths: columnResize.resetColumnWidths,
      clearFilters: filters.clearFilters,
    },
    desktopRagSearchProps: canUseRagSearch
      ? {
          ragQuery: rag.ragQuery,
          setRagQuery: rag.setRagQuery,
          isRagMode: rag.isRagMode,
          ragLoading: rag.ragLoading,
          onSubmit: rag.handleRagSubmit,
          onBack: () => rag.exitRagMode(false),
          onClear: () => (rag.isRagMode ? rag.exitRagMode(true) : rag.setRagQuery("")),
        }
      : null,
    ragResultsProps: rag.isRagMode
      ? {
          results: rag.ragResults,
          loading: rag.ragLoading,
          error: rag.ragError,
          onRetry: () => {
            void rag.executeRagSearch(rag.ragSubmittedQuery || rag.ragQuery);
          },
          onOpenResult: openRagResult,
        }
      : null,
    mobileFilterChipsProps: {
      dateYear: filters.dateYear,
      handleDateYearChange: handleMobileDateYearChange,
      locationFilter: filters.locationFilter,
      setLocationFilter: filters.setLocationFilter,
      filterOptions,
      hasActiveFilters: filters.hasActiveFilters,
      clearFilters: filters.clearFilters,
    },
    mobileCardViewProps: {
      entries,
      groupId: data.groupId,
    },
    mobileSearchOverlayProps: canUseRagSearch
      ? {
          open: searchOverlayOpen,
          ragQuery: rag.ragQuery,
          ragSubmittedQuery: rag.ragSubmittedQuery,
          ragResults: rag.ragResults,
          ragLoading: rag.ragLoading,
          ragError: rag.ragError,
          setRagQuery: rag.setRagQuery,
          onSubmit: rag.handleRagSubmit,
          onRetry: () => {
            void rag.executeRagSearch(rag.ragSubmittedQuery || rag.ragQuery);
          },
          onOpenResult: openRagResult,
          onClear: () => rag.exitRagMode(true),
          onClose: closeMobileSearchOverlay,
        }
      : null,
    desktopTableProps: !rag.isRagMode
      ? {
          activeCatalogId,
          albums,
          allAlbums,
          allLocations,
          allRecorders,
          artists,
          availableDurations,
          availableMonths,
          availableParts,
          availableStatuses,
          availableVerified,
          availableYears,
          canManageAccess,
          columnResize,
          columnVisibility: columnVisibilityStateReady,
          duplicateCounts,
          entries,
          filters,
          hasDuplicateCounts,
          hasDurations,
          hasStatuses,
          hasVerifiedOptions,
          inlineEdit,
          lastVisibleColumnKey,
          locations,
          onOpenRecording: (hash: string) => {
            router.push(`/catalog/${data.groupId}/recording/${hash}`);
          },
          onTogglePublication: handleTogglePublication,
          publishingHashes,
          recorders,
          visibleColumnKeys,
        }
      : null,
    paginationProps: !rag.isRagMode
      ? {
          pagination: data.pagination,
          onPageChange: filters.handlePageChange,
          onLoadNext: loadMore.loadNextPage,
          onLoadAll: loadMore.loadAllPages,
          isLoadingNext: loadMore.isLoadingNext,
          isLoadingAll: loadMore.isLoadingAll,
          isLoadMoreMode: loadMore.isLoadMoreMode,
          loadedCount: loadMore.loadedCount,
          totalCount: data.total,
          hasMoreToLoad: loadMore.hasMoreToLoad,
        }
      : null,
    editModeToolbarProps: inlineEdit.isEditMode
      ? {
          modifiedCount: inlineEdit.modifiedCount,
          isSaving: inlineEdit.isSaving,
          onSave: inlineEdit.saveAllChanges,
          onDiscard: inlineEdit.discardChanges,
        }
      : null,
    unsavedChangesDialogProps: {
      open: inlineEdit.showUnsavedDialog,
      modifiedCount: inlineEdit.modifiedCount,
      onDiscard: inlineEdit.confirmDiscard,
      onCancel: inlineEdit.cancelDiscard,
      onSave: async () => {
        await inlineEdit.saveAllChanges();
        inlineEdit.cancelDiscard();
      },
      isSaving: inlineEdit.isSaving,
    },
  };
}
