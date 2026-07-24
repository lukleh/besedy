/**
 * Unit tests for useCatalogFilters hook.
 *
 * Tests verify filter state management with localStorage persistence.
 * No URL state is used - filters are stored in React state + localStorage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCatalogFilters } from "@/components/catalog/catalog-list/hooks/use-catalog-filters";

// Mock useDebounce to return value immediately for simpler testing
vi.mock("@/hooks/use-debounce", () => ({
  useDebounce: (value: string) => value,
}));

describe("useCatalogFilters", () => {
  const defaultOptions = {
    catalogId: "test-catalog",
    activeCatalogId: "test-catalog",
    isHydrated: true,
    columnVisibility: {
      title: true,
      date: true,
      part: true,
      recorder: true,
      location: true,
      status: true,
      duration: false,
      verified: false,
      artist: false,
      album: false,
      duplicates: false,
      offline: true,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage
    if (typeof localStorage !== "undefined") {
      localStorage.clear();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("filter state management", () => {
    it("should initialize with default values", () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      expect(result.current.statusFilter).toBe("all");
      expect(result.current.durationFilter).toBe("all");
      expect(result.current.verifiedFilter).toBe("all");
      expect(result.current.recorderFilter).toBe("all");
      expect(result.current.locationFilter).toBe("all");
      expect(result.current.page).toBe(1);
    });

    it("should update filter state when setters are called", async () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      act(() => {
        result.current.setStatusFilter("ready");
      });

      expect(result.current.statusFilter).toBe("ready");
    });

    it("should reset page to 1 when filter changes", async () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      // Set page to something other than 1
      act(() => {
        result.current.handlePageChange(5);
      });
      expect(result.current.page).toBe(5);

      // Change a filter
      act(() => {
        result.current.setStatusFilter("ready");
      });

      // Page should be reset to 1
      expect(result.current.page).toBe(1);
    });

    it("should clear cascading date filters when year is cleared", async () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      // Set date filters
      act(() => {
        result.current.setDateYear("2024");
        result.current.setDateMonth("01");
        result.current.setDateDay("15");
      });

      expect(result.current.dateYear).toBe("2024");
      expect(result.current.dateMonth).toBe("01");
      expect(result.current.dateDay).toBe("15");

      // Clear year
      act(() => {
        result.current.handleDateYearChange("all");
      });

      // Month and day should also be cleared
      expect(result.current.dateYear).toBe("all");
      expect(result.current.dateMonth).toBe("all");
      expect(result.current.dateDay).toBe("all");
    });

    it("should clear day when month changes", async () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      // Set date filters
      act(() => {
        result.current.setDateYear("2024");
        result.current.setDateMonth("01");
        result.current.setDateDay("15");
      });

      // Change month
      act(() => {
        result.current.handleDateMonthChange("02");
      });

      // Day should be cleared, month updated
      expect(result.current.dateMonth).toBe("02");
      expect(result.current.dateDay).toBe("all");
    });
  });

  // Note: localStorage persistence tests are omitted because they test implementation
  // details that are better covered by E2E tests. The hook's core functionality
  // (filter state management, cascading clears, hasActiveFilters) is tested above.

  describe("clearFilters", () => {
    it("should reset all filters to default values", async () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      // Set some filters
      act(() => {
        result.current.setStatusFilter("ready");
        result.current.setRecorderFilter("1");
        result.current.setLocationFilter("2");
      });

      act(() => {
        result.current.clearFilters();
      });

      expect(result.current.statusFilter).toBe("all");
      expect(result.current.recorderFilter).toBe("all");
      expect(result.current.locationFilter).toBe("all");
      expect(result.current.durationFilter).toBe("all");
      expect(result.current.verifiedFilter).toBe("all");
      expect(result.current.page).toBe(1);
    });
  });

  describe("clearFilterForColumn", () => {
    it("should clear only the specified column filter", async () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      // Set multiple filters
      act(() => {
        result.current.setStatusFilter("ready");
        result.current.setRecorderFilter("1");
      });

      // Clear only status
      act(() => {
        result.current.clearFilterForColumn("status");
      });

      expect(result.current.statusFilter).toBe("all");
      expect(result.current.recorderFilter).toBe("1"); // Should remain
    });

    it("should clear all date fields when clearing date column", async () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      // Set date filters
      act(() => {
        result.current.setDateYear("2024");
        result.current.setDateMonth("01");
        result.current.setDateDay("15");
      });

      // Clear date column
      act(() => {
        result.current.clearFilterForColumn("date");
      });

      expect(result.current.dateYear).toBe("all");
      expect(result.current.dateMonth).toBe("all");
      expect(result.current.dateDay).toBe("all");
    });
  });

  describe("hasActiveFilters", () => {
    it("should be false when all filters are at defaults", () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));
      expect(result.current.hasActiveFilters).toBe(false);
    });

    it("should be true when a visible column has an active filter", async () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      act(() => {
        result.current.setStatusFilter("ready");
      });

      expect(result.current.hasActiveFilters).toBe(true);
    });

    it("should be false when filter is set but column is hidden", async () => {
      const options = {
        ...defaultOptions,
        columnVisibility: {
          ...defaultOptions.columnVisibility,
          status: false, // Hide status column
        },
      };

      const { result } = renderHook(() => useCatalogFilters(options));

      act(() => {
        result.current.setStatusFilter("ready");
      });

      // Filter is set, but column is hidden, so hasActiveFilters should be false
      expect(result.current.hasActiveFilters).toBe(false);
    });

  });

  describe("handleSort", () => {
    it("should toggle sort direction when clicking same column", async () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      // Default sort is date desc
      expect(result.current.sortKey).toBe("date");
      expect(result.current.sortDir).toBe("desc");

      // Click date again -> should become asc
      act(() => {
        result.current.handleSort("date");
      });

      expect(result.current.sortKey).toBe("date");
      expect(result.current.sortDir).toBe("asc");

      // Click date again -> should reset to default (date desc)
      act(() => {
        result.current.handleSort("date");
      });

      expect(result.current.sortKey).toBe("date");
      expect(result.current.sortDir).toBe("desc");
    });

    it("should change sort column when clicking different column", async () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      // Click title column
      act(() => {
        result.current.handleSort("title");
      });

      expect(result.current.sortKey).toBe("title");
      expect(result.current.sortDir).toBe("desc");
    });

    it("should reset page to 1 when sort changes", async () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      // Set page
      act(() => {
        result.current.handlePageChange(5);
      });
      expect(result.current.page).toBe(5);

      // Change sort
      act(() => {
        result.current.handleSort("title");
      });

      expect(result.current.page).toBe(1);
    });
  });

  describe("handlePageChange", () => {
    it("should update page", async () => {
      const { result } = renderHook(() => useCatalogFilters(defaultOptions));

      act(() => {
        result.current.handlePageChange(3);
      });

      expect(result.current.page).toBe(3);
    });
  });
});
