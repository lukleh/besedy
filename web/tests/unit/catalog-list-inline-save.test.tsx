import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/fetch-json";
import { useCatalogListController } from "@/components/catalog/catalog-list/hooks/use-catalog-list-controller";
import type { RagSearchResult } from "@/components/catalog/catalog-list/hooks/use-rag-search";

const mocks = vi.hoisted(() => {
  const inlineEditState = {
    isEditMode: false,
    toggleEditMode: vi.fn(),
    exitEditMode: vi.fn(() => true),
    pendingChanges: new Map(),
    hasUnsavedChanges: false,
    modifiedCount: 0,
    updateField: vi.fn(),
    getCellValue: vi.fn((_: string, __: string, original: unknown) => original),
    isModified: vi.fn(() => false),
    saveAllChanges: vi.fn(),
    discardChanges: vi.fn(),
    isSaving: false,
    activeCell: null,
    setActiveCell: vi.fn(),
    clearActiveCell: vi.fn(),
    saveErrors: new Map(),
    showUnsavedDialog: false,
    confirmDiscard: vi.fn(),
    cancelDiscard: vi.fn(),
  };

  const filtersState = {
    statusFilter: "all",
    durationFilter: "all",
    verifiedFilter: "all",
    recorderFilter: "all",
    locationFilter: "all",
    partFilter: "all",
    dateYear: "all",
    dateMonth: "all",
    dateDay: "all",
    artistFilter: "all",
    albumFilter: "all",
    duplicatesFilter: "all",
    sortKey: "date",
    sortDir: "desc",
    page: 1,
    setStatusFilter: vi.fn(),
    setDurationFilter: vi.fn(),
    setVerifiedFilter: vi.fn(),
    setRecorderFilter: vi.fn(),
    setLocationFilter: vi.fn(),
    setPartFilter: vi.fn(),
    setDateYear: vi.fn(),
    setDateMonth: vi.fn(),
    setDateDay: vi.fn(),
    setArtistFilter: vi.fn(),
    setAlbumFilter: vi.fn(),
    setDuplicatesFilter: vi.fn(),
    handleDateYearChange: vi.fn(),
    handleDateMonthChange: vi.fn(),
    handleSort: vi.fn(),
    handlePageChange: vi.fn(),
    clearFilters: vi.fn(),
    clearFilterForColumn: vi.fn(),
    resetPageIfInvalid: vi.fn(),
    hasActiveFilters: false,
    filtersReady: true,
    syncWithAvailableOptions: vi.fn(),
  };

  const columnVisibilityState = {
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

  const columnVisibility = {
    columnVisibility: columnVisibilityState,
    visibleColumnKeys: ["title", "date", "status"],
    toggleColumn: vi.fn(),
    resetColumns: vi.fn(),
    hasNonDefaultColumns: false,
  };

  const catalogEntry = {
    hash: "a".repeat(64),
    filename: "recording.wav",
    hasArchived: true,
    hasMetadata: true,
    isActionable: true,
    isPublished: true,
    hasArchivedAudio: true,
    hasOriginalAudio: true,
  };

  const catalogData = {
    groupId: "catalog-1",
    groupLabel: "Catalog 1",
    totalAll: 1,
    total: 1,
    actionable: 1,
    verified: 0,
    entries: [catalogEntry],
    pagination: {
      page: 1,
      limit: 50,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
    },
    accessLevel: "EDITOR",
    canBatchEditMetadata: true,
    canUseRagSearch: true,
    canManageAccess: true,
    lastModifiedAt: "2026-03-13T12:00:00.000Z",
  };

  const loadMoreState = {
    displayEntries: [catalogEntry],
    error: null,
    loadNextPage: vi.fn(),
    loadAllPages: vi.fn(),
    isLoadingNext: false,
    isLoadingAll: false,
    isLoadMoreMode: false,
    loadedCount: 1,
    hasMoreToLoad: false,
  };

  const ragSearchState = {
    ragQuery: "",
    setRagQuery: vi.fn(),
    isRagMode: false,
    ragLoading: false,
    ragResults: [] as RagSearchResult[],
    ragError: null,
    handleRagSubmit: vi.fn(),
    exitRagMode: vi.fn(),
    executeRagSearch: vi.fn(),
    ragSubmittedQuery: "",
    hideRagMode: vi.fn(),
  };

  return {
    isDesktop: true,
    invalidateQueriesMock: vi.fn(),
    toastMock: vi.fn(),
    pushMock: vi.fn(),
    markAsSyncedMock: vi.fn(),
    capturedInlineEditOptions: null as {
      onSaveSuccess?: () => void;
      onSaveError?: (errors: Array<{ hash: string; success: boolean; error?: string }>) => void;
    } | null,
    inlineEditState,
    filtersState,
    columnVisibility,
    filterOptionsState: {
      data: undefined,
      error: null as Error | null,
    },
    catalogData,
    loadMoreState,
    ragSearchState,
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueriesMock,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.pushMock }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "catalog.ragSearch.resultsCount" || key === "ragSearch.resultsCount") {
      return `results:${values?.count ?? 0}`;
    }
    return key;
  },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toastMock }),
}));

vi.mock("@/hooks/use-catalog-context", () => ({
  useCatalogContext: () => ({
    catalogId: "catalog-1",
    activeGroup: { id: "catalog-1", label: "Catalog 1" },
    groupKey: "catalog-1",
    isLoading: false,
    catalogNotFound: false,
    catalogValidationLoading: false,
  }),
}));

vi.mock("@/hooks/use-filter-options", () => ({
  useFilterOptions: () => mocks.filterOptionsState,
}));

vi.mock("@/hooks/use-metadata-enums", () => ({
  useRecorders: () => ({ data: [] }),
  useLocations: () => ({ data: [] }),
  useAlbums: () => ({ data: [] }),
}));

vi.mock("@/hooks/use-media-query", () => ({
  useIsDesktop: () => mocks.isDesktop,
}));

vi.mock("@/hooks/use-column-resize", () => ({
  useColumnResize: () => ({
    resetColumnWidths: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-catalog-status", () => ({
  useCatalogStatus: () => ({
    markAsSynced: mocks.markAsSyncedMock,
  }),
}));

vi.mock("@/components/catalog/inline-edit", () => ({
  useInlineEdit: (options: unknown) => {
    mocks.capturedInlineEditOptions = options as typeof mocks.capturedInlineEditOptions;
    return mocks.inlineEditState;
  },
}));

vi.mock("@/components/catalog/catalog-list/hooks/use-catalog-filters", () => ({
  useCatalogFilters: () => mocks.filtersState,
}));

vi.mock("@/components/catalog/catalog-list/hooks/use-column-visibility", () => ({
  useColumnVisibility: () => mocks.columnVisibility,
}));

vi.mock("@/components/catalog/catalog-list/hooks/use-catalog-data", () => ({
  useCatalogData: () => ({
    data: mocks.catalogData,
    isLoading: false,
    isFetching: false,
    error: null,
    dataUpdatedAt: 1,
  }),
}));

vi.mock("@/components/catalog/catalog-list/hooks/use-load-more", () => ({
  useLoadMore: () => mocks.loadMoreState,
}));

vi.mock("@/components/catalog/catalog-list/hooks/use-publication-state", () => ({
  usePublicationState: () => ({
    publishingHashes: new Set<string>(),
    handleTogglePublication: vi.fn(),
  }),
}));

vi.mock("@/components/catalog/catalog-list/hooks/use-rag-search", () => ({
  useRagSearch: () => mocks.ragSearchState,
}));

vi.mock("@/components/catalog/catalog-list/hooks/use-url-filter-sync", () => ({
  useUrlFilterSync: () => ({
    urlFilterValuesRef: { current: null },
  }),
}));

describe("useCatalogListController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capturedInlineEditOptions = null;
    mocks.filterOptionsState.data = undefined;
    mocks.filterOptionsState.error = null;
    mocks.isDesktop = true;
    mocks.inlineEditState.hasUnsavedChanges = false;
    mocks.inlineEditState.isEditMode = false;
    mocks.inlineEditState.modifiedCount = 0;
    mocks.filtersState.handleDateYearChange.mockReset();
    mocks.filtersState.setDateMonth.mockReset();
    mocks.filtersState.setDateDay.mockReset();
  });

  it("revalidates the catalog query after a successful inline save", async () => {
    renderHook(() => useCatalogListController({ catalogId: "catalog-1" }));

    expect(mocks.capturedInlineEditOptions?.onSaveSuccess).toBeTypeOf("function");

    mocks.capturedInlineEditOptions?.onSaveSuccess?.();

    await waitFor(() => {
      expect(mocks.toastMock).toHaveBeenCalledWith({
        title: "saveSuccess",
        description: "saveSuccessDescription",
      });
      expect(mocks.invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: ["catalog"],
      });
    });
  });

  it("fails closed when filter options confirm access was revoked", async () => {
    mocks.filterOptionsState.error = new ApiError("Access denied", 403);

    const { result } = renderHook(() =>
      useCatalogListController({ catalogId: "catalog-1" })
    );

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });

    if (result.current.status !== "error") {
      throw new Error("Expected controller error state");
    }

    expect(result.current.error.message).toBe("Access denied");
  });

  it("blocks RAG result navigation while inline edits are unsaved", async () => {
    mocks.inlineEditState.hasUnsavedChanges = true;
    mocks.inlineEditState.modifiedCount = 2;
    mocks.ragSearchState.isRagMode = true;
    mocks.ragSearchState.ragResults = [
      {
        rank: 1,
        audioHash: "b".repeat(64),
        chunkId: "chunk-1",
        score: 0.9,
        startSec: 12,
        endSec: 18,
        text: "match",
        contextText: "context",
        contextStartSec: 10,
        contextEndSec: 20,
        neighbors: { before: [], after: [] },
        metadata: { date: null, location: null, recorder: null },
        citation: {
          audioHash: "b".repeat(64),
          chunkId: "chunk-1",
          startSec: 12,
          endSec: 18,
          workflowGroupId: "catalog-1",
          backendKey: "backend",
          chunkVersion: "v1",
        },
        provenance: {
          workflowGroupId: "catalog-1",
          backendKey: "backend",
          runId: "run-1",
          chunkVersion: "v1",
          embeddingModel: "model",
          embeddingModelVersion: "v1",
        },
      },
    ];

    const { result } = renderHook(() =>
      useCatalogListController({ catalogId: "catalog-1" })
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    if (result.current.status !== "ready" || !result.current.ragResultsProps) {
      throw new Error("Expected ready controller with RAG results");
    }

    result.current.ragResultsProps.onOpenResult(mocks.ragSearchState.ragResults[0]);

    expect(mocks.pushMock).not.toHaveBeenCalled();
    expect(mocks.toastMock).toHaveBeenCalledWith({
      title: "unsavedDialogTitle",
      description: "unsavedDialogDescription",
      variant: "destructive",
    });
  });

  it("clears hidden month and day filters from the mobile year picker", async () => {
    mocks.isDesktop = false;

    const { result } = renderHook(() =>
      useCatalogListController({ catalogId: "catalog-1" })
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    if (result.current.status !== "ready") {
      throw new Error("Expected ready controller state");
    }

    result.current.mobileFilterChipsProps.handleDateYearChange("2026");

    expect(mocks.filtersState.handleDateYearChange).toHaveBeenCalledWith("2026");
    expect(mocks.filtersState.setDateMonth).toHaveBeenCalledWith("all");
    expect(mocks.filtersState.setDateDay).toHaveBeenCalledWith("all");
  });
});
