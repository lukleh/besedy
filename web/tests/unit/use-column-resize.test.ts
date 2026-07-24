import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useColumnResize, type ColumnKey } from "@/hooks/use-column-resize";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

describe("useColumnResize", () => {
  const visibleColumns: ColumnKey[] = ["title", "date", "part", "location", "recorder"];

  // Create a mock header element for scale factor calculation
  // The mock returns the same width as specified, so scale factor = 1 (no scaling)
  const createMockHeaderElement = (width: number): HTMLElement => ({
    getBoundingClientRect: () => ({ width, height: 40, top: 0, left: 0, right: width, bottom: 40, x: 0, y: 0, toJSON: () => {} }),
  } as unknown as HTMLElement);

  beforeEach(() => {
    vi.stubGlobal("localStorage", localStorageMock);
    localStorageMock.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("initialization", () => {
    it("initializes with default widths", () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      expect(result.current.columnWidths.title).toBe(200);
      expect(result.current.columnWidths.date).toBe(150);
      expect(result.current.columnWidths.part).toBe(80);
    });

    it("loads stored widths from localStorage", () => {
      const storedWidths = { title: 250, date: 180 };
      localStorageMock.getItem.mockReturnValueOnce(JSON.stringify(storedWidths));

      const { result } = renderHook(() => useColumnResize(visibleColumns));

      expect(result.current.columnWidths.title).toBe(250);
      expect(result.current.columnWidths.date).toBe(180);
      // Other columns should have defaults
      expect(result.current.columnWidths.part).toBe(80);
    });

    it("handles invalid localStorage gracefully", () => {
      localStorageMock.getItem.mockReturnValueOnce("invalid json");

      const { result } = renderHook(() => useColumnResize(visibleColumns));

      // Should fall back to defaults
      expect(result.current.columnWidths.title).toBe(200);
    });

    it("starts with no resize in progress", () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      expect(result.current.isResizing).toBe(false);
      expect(result.current.resizingColumn).toBeNull();
    });
  });

  describe("startResize", () => {
    it("sets resizing state when starting resize", () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      act(() => {
        result.current.startResize("title", 100, createMockHeaderElement(200));
      });

      expect(result.current.isResizing).toBe(true);
      expect(result.current.resizingColumn).toBe("title");
    });
  });

  describe("resetColumnWidths", () => {
    it("resets all columns to default widths", () => {
      const storedWidths = { title: 300, date: 200, part: 100 };
      localStorageMock.getItem.mockReturnValueOnce(JSON.stringify(storedWidths));

      const { result } = renderHook(() => useColumnResize(visibleColumns));

      // Verify loaded widths
      expect(result.current.columnWidths.title).toBe(300);

      // Reset
      act(() => {
        result.current.resetColumnWidths();
      });

      expect(result.current.columnWidths.title).toBe(200);
      expect(result.current.columnWidths.date).toBe(150);
      expect(result.current.columnWidths.part).toBe(80);
    });

    it("removes stored widths from localStorage", () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      act(() => {
        result.current.resetColumnWidths();
      });

      expect(localStorageMock.removeItem).toHaveBeenCalledWith("besedy-catalog-column-widths");
    });
  });

  describe("getColumnStyle", () => {
    it("returns style object with width, minWidth, and maxWidth", () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      const style = result.current.getColumnStyle("title");

      expect(style).toEqual({
        width: 200,
        minWidth: 80,
        maxWidth: 500,
      });
    });

    it("uses current width from state", () => {
      const storedWidths = { title: 250 };
      localStorageMock.getItem.mockReturnValueOnce(JSON.stringify(storedWidths));

      const { result } = renderHook(() => useColumnResize(visibleColumns));

      const style = result.current.getColumnStyle("title");

      expect(style.width).toBe(250);
    });
  });

  describe("column constraints", () => {
    it("has correct min widths for all columns", () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      // Check a few key columns
      expect(result.current.getColumnStyle("title").minWidth).toBe(80);
      expect(result.current.getColumnStyle("part").minWidth).toBe(40);
      expect(result.current.getColumnStyle("verified").minWidth).toBe(50);
    });

    it("has correct max widths for all columns", () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      expect(result.current.getColumnStyle("title").maxWidth).toBe(500);
      expect(result.current.getColumnStyle("part").maxWidth).toBe(120);
      expect(result.current.getColumnStyle("duration").maxWidth).toBe(150);
    });
  });

  describe("mouse event handling", () => {
    it("updates column widths on mouse move during resize", async () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      // Start resizing title column
      act(() => {
        result.current.startResize("title", 100, createMockHeaderElement(200));
      });

      // Simulate mouse move - drag right by 50px
      act(() => {
        const moveEvent = new MouseEvent("mousemove", { clientX: 150 });
        document.dispatchEvent(moveEvent);
      });

      // Title should increase, date (next column) should decrease
      expect(result.current.columnWidths.title).toBe(250);
      expect(result.current.columnWidths.date).toBe(100);
    });

    it("respects minimum width during resize", () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      // Start resizing title column
      act(() => {
        result.current.startResize("title", 100, createMockHeaderElement(200));
      });

      // Simulate mouse move - drag left by a lot (would go below min)
      act(() => {
        const moveEvent = new MouseEvent("mousemove", { clientX: -100 });
        document.dispatchEvent(moveEvent);
      });

      // Title should not go below min (80)
      expect(result.current.columnWidths.title).toBeGreaterThanOrEqual(80);
    });

    it("respects maximum width during resize", () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      // Start resizing title column
      act(() => {
        result.current.startResize("title", 100, createMockHeaderElement(200));
      });

      // Simulate mouse move - drag right by a lot (would go above max)
      act(() => {
        const moveEvent = new MouseEvent("mousemove", { clientX: 600 });
        document.dispatchEvent(moveEvent);
      });

      // Title should not go above max (500)
      expect(result.current.columnWidths.title).toBeLessThanOrEqual(500);
    });

    it("saves to localStorage on mouse up", () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      // Start resizing
      act(() => {
        result.current.startResize("title", 100, createMockHeaderElement(200));
      });

      // Move and release
      act(() => {
        const moveEvent = new MouseEvent("mousemove", { clientX: 150 });
        document.dispatchEvent(moveEvent);
      });

      act(() => {
        const upEvent = new MouseEvent("mouseup");
        document.dispatchEvent(upEvent);
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "besedy-catalog-column-widths",
        expect.any(String)
      );
    });

    it("clears resizing state on mouse up", () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      act(() => {
        result.current.startResize("title", 100, createMockHeaderElement(200));
      });

      expect(result.current.isResizing).toBe(true);

      act(() => {
        const upEvent = new MouseEvent("mouseup");
        document.dispatchEvent(upEvent);
      });

      expect(result.current.isResizing).toBe(false);
      expect(result.current.resizingColumn).toBeNull();
    });
  });

  describe("adjacent column resizing", () => {
    it("only affects the two adjacent columns when resizing", () => {
      const { result } = renderHook(() => useColumnResize(visibleColumns));

      const initialPartWidth = result.current.columnWidths.part;
      const initialLocationWidth = result.current.columnWidths.location;

      // Resize title column
      act(() => {
        result.current.startResize("title", 100, createMockHeaderElement(200));
      });

      act(() => {
        const moveEvent = new MouseEvent("mousemove", { clientX: 150 });
        document.dispatchEvent(moveEvent);
      });

      // Part and location (not adjacent to title) should be unchanged
      expect(result.current.columnWidths.part).toBe(initialPartWidth);
      expect(result.current.columnWidths.location).toBe(initialLocationWidth);
    });
  });
});
