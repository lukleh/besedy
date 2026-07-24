import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useLoadMore } from "@/components/catalog/catalog-list/hooks/use-load-more";
import type { CatalogEntry, PaginationInfo, CatalogResponse } from "@/components/catalog/catalog-list/types";

// Mock entries for testing
const createEntry = (hash: string): CatalogEntry => ({
  hash,
  hasArchived: false,
  hasMetadata: false,
  isActionable: false,
  isPublished: false,
  hasArchivedAudio: false,
  hasOriginalAudio: false,
});

const page1Entries = [createEntry("hash-1"), createEntry("hash-2")];
const page2Entries = [createEntry("hash-3"), createEntry("hash-4")];
const allEntries = [...page1Entries, ...page2Entries];

const pagination: PaginationInfo = {
  page: 1,
  limit: 50,
  totalPages: 2,
  hasNextPage: true,
  hasPrevPage: false,
};

const defaultOptions: Parameters<typeof useLoadMore>[0] = {
  activeCatalogId: "test-catalog",
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
  currentPage: 1,
  currentEntries: page1Entries,
  pagination,
  baseDataUpdatedAt: 100,
};

function createCatalogResponse(
  entries: CatalogEntry[],
  paginationOverrides: Partial<CatalogResponse["pagination"]> = {}
): CatalogResponse {
  return {
    groupId: "test-catalog",
    groupLabel: "Test",
    total: entries.length,
    actionable: 0,
    verified: 0,
    entries,
    pagination: {
      ...pagination,
      ...paginationOverrides,
    },
  };
}

describe("useLoadMore", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("AbortController", class {
      signal = { aborted: false };
      abort() {
        (this.signal as { aborted: boolean }).aborted = true;
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("initial state", () => {
    it("starts in non-load-more mode", () => {
      const { result } = renderHook(() => useLoadMore(defaultOptions));

      expect(result.current.isLoadMoreMode).toBe(false);
      expect(result.current.displayEntries).toEqual(page1Entries);
      expect(result.current.loadedCount).toBe(2);
      expect(result.current.isLoadingNext).toBe(false);
      expect(result.current.isLoadingAll).toBe(false);
      expect(result.current.hasMoreToLoad).toBe(true);
      expect(result.current.error).toBe(null);
    });

    it("returns false for hasMoreToLoad when on last page", () => {
      const { result } = renderHook(() =>
        useLoadMore({
          ...defaultOptions,
          pagination: { ...pagination, hasNextPage: false },
        })
      );

      expect(result.current.hasMoreToLoad).toBe(false);
    });
  });

  describe("loadNextPage", () => {
    it("fetches and appends entries from next page", async () => {
      const page2Response: CatalogResponse = {
        groupId: "test-catalog",
        groupLabel: "Test",
        total: 4,
        actionable: 0,
        verified: 0,
        entries: page2Entries,
        pagination: { ...pagination, page: 2, hasNextPage: false, hasPrevPage: true },
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => page2Response,
      } as Response);

      const { result } = renderHook(() => useLoadMore(defaultOptions));

      await act(async () => {
        await result.current.loadNextPage();
      });

      expect(result.current.isLoadMoreMode).toBe(true);
      expect(result.current.displayEntries).toHaveLength(4);
      expect(result.current.displayEntries).toEqual([...page1Entries, ...page2Entries]);
      expect(result.current.loadedCount).toBe(4);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/catalog?"),
        expect.objectContaining({ signal: expect.anything() })
      );
    });

    it("sets loading state during fetch", async () => {
      let resolvePromise: (value: Response) => void;
      fetchMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
      );

      const { result } = renderHook(() => useLoadMore(defaultOptions));

      act(() => {
        result.current.loadNextPage();
      });

      expect(result.current.isLoadingNext).toBe(true);

      await act(async () => {
        resolvePromise!({
          ok: true,
          json: async () => createCatalogResponse(page2Entries, { page: 2 }),
        } as Response);
      });

      await waitFor(() => {
        expect(result.current.isLoadingNext).toBe(false);
      });
    });

    it("sets error state on fetch failure", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Test error message" }),
      } as Response);

      const { result } = renderHook(() => useLoadMore(defaultOptions));

      await act(async () => {
        await result.current.loadNextPage();
      });

      expect(result.current.error).toBe("Test error message");
      expect(result.current.isLoadMoreMode).toBe(false);
    });

    it("does not fetch when already loading", async () => {
      let resolvePromise: (value: Response) => void;
      fetchMock.mockReturnValue(
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
      );

      const { result } = renderHook(() => useLoadMore(defaultOptions));

      // Start first load
      act(() => {
        result.current.loadNextPage();
      });

      expect(result.current.isLoadingNext).toBe(true);

      // Try second load while first is in progress - should be ignored
      act(() => {
        result.current.loadNextPage();
      });

      // Still only one call
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Clean up
      await act(async () => {
        resolvePromise!({
          ok: true,
          json: async () => createCatalogResponse([], {}),
        } as Response);
      });
    });

    it("does not fetch when on last page", async () => {
      const { result } = renderHook(() =>
        useLoadMore({
          ...defaultOptions,
          pagination: { ...pagination, page: 2, totalPages: 2, hasNextPage: false },
          currentPage: 2,
        })
      );

      await act(async () => {
        await result.current.loadNextPage();
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("resets accumulated entries when fresh base catalog data arrives", async () => {
      const page2Response: CatalogResponse = {
        groupId: "test-catalog",
        groupLabel: "Test",
        total: 4,
        actionable: 0,
        verified: 0,
        entries: page2Entries,
        pagination: { ...pagination, page: 2, hasNextPage: false, hasPrevPage: true },
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => page2Response,
      } as Response);

      const { result, rerender } = renderHook(
        (options: Parameters<typeof useLoadMore>[0]) => useLoadMore(options),
        { initialProps: defaultOptions }
      );

      await act(async () => {
        await result.current.loadNextPage();
      });

      expect(result.current.isLoadMoreMode).toBe(true);
      expect(result.current.displayEntries).toEqual(allEntries);

      const refreshedEntries = [createEntry("hash-1")];

      rerender({
        ...defaultOptions,
        currentEntries: refreshedEntries,
        pagination: {
          ...pagination,
          totalPages: 1,
          hasNextPage: false,
        },
        baseDataUpdatedAt: 200,
      });

      await waitFor(() => {
        expect(result.current.isLoadMoreMode).toBe(false);
        expect(result.current.displayEntries).toEqual(refreshedEntries);
        expect(result.current.loadedCount).toBe(1);
      });
    });

    it("discards an in-flight load-more response after fresh base catalog data arrives", async () => {
      let resolvePromise: ((value: Response) => void) | undefined;
      fetchMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
      );

      const { result, rerender } = renderHook(
        (options: Parameters<typeof useLoadMore>[0]) => useLoadMore(options),
        { initialProps: defaultOptions }
      );

      act(() => {
        result.current.loadNextPage();
      });

      await waitFor(() => {
        expect(result.current.isLoadingNext).toBe(true);
      });

      const refreshedEntries = [createEntry("hash-fresh")];
      rerender({
        ...defaultOptions,
        currentEntries: refreshedEntries,
        pagination: {
          ...pagination,
          totalPages: 1,
          hasNextPage: false,
        },
        baseDataUpdatedAt: 200,
      });

      await waitFor(() => {
        expect(result.current.isLoadMoreMode).toBe(false);
        expect(result.current.displayEntries).toEqual(refreshedEntries);
        expect(result.current.isLoadingNext).toBe(false);
      });

      await act(async () => {
        resolvePromise?.({
          ok: true,
          json: async () => createCatalogResponse(page2Entries, { page: 2 }),
        } as Response);
      });

      expect(result.current.isLoadMoreMode).toBe(false);
      expect(result.current.displayEntries).toEqual(refreshedEntries);
      expect(result.current.loadedCount).toBe(1);
    });
  });

  describe("loadAllPages", () => {
    it("fetches all entries with limit=0", async () => {
      const allResponse: CatalogResponse = {
        groupId: "test-catalog",
        groupLabel: "Test",
        total: 4,
        actionable: 0,
        verified: 0,
        entries: allEntries,
        pagination: { ...pagination, totalPages: 1 },
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => allResponse,
      } as Response);

      const { result } = renderHook(() => useLoadMore(defaultOptions));

      await act(async () => {
        await result.current.loadAllPages();
      });

      expect(result.current.isLoadMoreMode).toBe(true);
      expect(result.current.displayEntries).toEqual(allEntries);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("limit=0"),
        expect.anything()
      );
    });

    it("sets isLoadingAll during fetch", async () => {
      let resolvePromise: (value: Response) => void;
      fetchMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
      );

      const { result } = renderHook(() => useLoadMore(defaultOptions));

      act(() => {
        result.current.loadAllPages();
      });

      expect(result.current.isLoadingAll).toBe(true);

      await act(async () => {
        resolvePromise!({
          ok: true,
          json: async () => createCatalogResponse(allEntries, {}),
        } as Response);
      });

      await waitFor(() => {
        expect(result.current.isLoadingAll).toBe(false);
      });
    });
  });

  describe("reset behavior", () => {
    it("resets when filters change", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => createCatalogResponse(page2Entries, { page: 2 }),
      } as Response);

      const { result, rerender } = renderHook(
        (props) => useLoadMore(props),
        { initialProps: defaultOptions }
      );

      // Load more
      await act(async () => {
        await result.current.loadNextPage();
      });

      expect(result.current.isLoadMoreMode).toBe(true);

      // Change filter
      rerender({ ...defaultOptions, statusFilter: "ready" });

      expect(result.current.isLoadMoreMode).toBe(false);
      expect(result.current.displayEntries).toEqual(page1Entries);
    });

    it("resets when currentPage changes (user navigated via Prev/Next)", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => createCatalogResponse(page2Entries, { page: 2 }),
      } as Response);

      const { result, rerender } = renderHook(
        (props) => useLoadMore(props),
        { initialProps: defaultOptions }
      );

      // Load more
      await act(async () => {
        await result.current.loadNextPage();
      });

      expect(result.current.isLoadMoreMode).toBe(true);

      // Simulate user clicking "Next" pagination button
      rerender({ ...defaultOptions, currentPage: 2, currentEntries: page2Entries });

      expect(result.current.isLoadMoreMode).toBe(false);
    });

    it("does not reset in load-more mode when currentPage stays the same", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => createCatalogResponse(page2Entries, { page: 2 }),
      } as Response);

      const { result, rerender } = renderHook(
        (props) => useLoadMore(props),
        { initialProps: defaultOptions }
      );

      // Load more
      await act(async () => {
        await result.current.loadNextPage();
      });

      expect(result.current.isLoadMoreMode).toBe(true);

      // Rerender with same page but updated entries (e.g., from new data)
      rerender({ ...defaultOptions, currentEntries: page1Entries });

      // Should still be in load-more mode since page didn't change
      expect(result.current.isLoadMoreMode).toBe(true);
    });

    it("clears error on reset", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Test error" }),
      } as Response);

      const { result, rerender } = renderHook(
        (props) => useLoadMore(props),
        { initialProps: defaultOptions }
      );

      await act(async () => {
        await result.current.loadNextPage();
      });

      expect(result.current.error).toBe("Test error");

      // Change filter to trigger reset
      rerender({ ...defaultOptions, statusFilter: "ready" });

      expect(result.current.error).toBe(null);
    });
  });

  describe("manual reset", () => {
    it("resets all state when reset() is called", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => createCatalogResponse(page2Entries, { page: 2 }),
      } as Response);

      const { result } = renderHook(() => useLoadMore(defaultOptions));

      await act(async () => {
        await result.current.loadNextPage();
      });

      expect(result.current.isLoadMoreMode).toBe(true);

      act(() => {
        result.current.reset();
      });

      expect(result.current.isLoadMoreMode).toBe(false);
      expect(result.current.displayEntries).toEqual(page1Entries);
    });
  });

  describe("hasMoreToLoad", () => {
    it("returns true when in load-more mode with more pages", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => createCatalogResponse(page2Entries, { page: 2 }),
      } as Response);

      const { result } = renderHook(() =>
        useLoadMore({
          ...defaultOptions,
          pagination: { ...pagination, totalPages: 3 },
        })
      );

      await act(async () => {
        await result.current.loadNextPage();
      });

      // highestLoadedPage is 2, totalPages is 3
      expect(result.current.hasMoreToLoad).toBe(true);
    });

    it("returns false when all pages loaded", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          createCatalogResponse(page2Entries, { page: 2, totalPages: 2 }),
      } as Response);

      const { result } = renderHook(() => useLoadMore(defaultOptions));

      await act(async () => {
        await result.current.loadNextPage();
      });

      // highestLoadedPage is 2, totalPages is 2
      expect(result.current.hasMoreToLoad).toBe(false);
    });
  });
});
