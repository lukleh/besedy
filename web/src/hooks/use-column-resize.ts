"use client";

import { useState, useCallback, useRef, useEffect } from "react";

export type ColumnKey =
  | "title"
  | "date"
  | "part"
  | "location"
  | "recorder"
  | "duration"
  | "artist"
  | "album"
  | "status"
  | "verified"
  | "duplicates";

type ColumnWidths = Record<ColumnKey, number>;

const STORAGE_KEY = "besedy-catalog-column-widths";

const DEFAULT_WIDTHS: ColumnWidths = {
  title: 200,
  date: 150,
  part: 80,
  location: 120,
  recorder: 120,
  duration: 100,
  artist: 120,
  album: 120,
  status: 100,
  verified: 80,
  duplicates: 80,
};

const MIN_WIDTHS: ColumnWidths = {
  title: 80,
  date: 60,
  part: 40,
  location: 60,
  recorder: 60,
  duration: 60,
  artist: 60,
  album: 60,
  status: 60,
  verified: 50,
  duplicates: 50,
};

const MAX_WIDTHS: ColumnWidths = {
  title: 500,
  date: 300,
  part: 120,
  location: 300,
  recorder: 300,
  duration: 150,
  artist: 300,
  album: 300,
  status: 150,
  verified: 120,
  duplicates: 120,
};

function loadColumnWidths(): ColumnWidths {
  if (typeof window === "undefined") return DEFAULT_WIDTHS;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_WIDTHS, ...JSON.parse(stored) };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_WIDTHS;
}

export interface UseColumnResizeReturn {
  columnWidths: ColumnWidths;
  isResizing: boolean;
  resizingColumn: ColumnKey | null;
  startResize: (column: ColumnKey, startX: number, headerElement: HTMLElement) => void;
  resetColumnWidths: () => void;
  getColumnStyle: (column: ColumnKey) => React.CSSProperties;
}

/**
 * Hook for resizable table columns with proportional group redistribution.
 * When dragging a separator, columns on the left and right of the separator
 * are resized proportionally within their respective groups.
 *
 * @param visibleColumnKeys - Array of currently visible column keys in display order
 */
export function useColumnResize(
  visibleColumnKeys: ColumnKey[]
): UseColumnResizeReturn {
  // Initialize with defaults to prevent hydration mismatch
  // localStorage values are loaded after hydration in useEffect
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(DEFAULT_WIDTHS);
  const [resizingColumn, setResizingColumn] = useState<ColumnKey | null>(null);

  const startXRef = useRef(0);
  const startWidthsRef = useRef<ColumnWidths>(columnWidths);
  const scaleFactorRef = useRef(1);

  // Load column widths from localStorage after hydration
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    const stored = loadColumnWidths();
    // Only update if there are stored values different from defaults
    const hasStoredValues = Object.keys(stored).some(
      (key) => stored[key as ColumnKey] !== DEFAULT_WIDTHS[key as ColumnKey]
    );
    if (hasStoredValues) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setColumnWidths(stored);
    }
  }, [isHydrated]);

  // Use refs to access current widths and visible keys in event handlers
  const columnWidthsRef = useRef(columnWidths);
  const visibleKeysRef = useRef(visibleColumnKeys);

  // Sync refs in effects (not during render)
  useEffect(() => {
    columnWidthsRef.current = columnWidths;
  }, [columnWidths]);

  useEffect(() => {
    visibleKeysRef.current = visibleColumnKeys;
  }, [visibleColumnKeys]);

  const startResize = useCallback((column: ColumnKey, startX: number, headerElement: HTMLElement) => {
    setResizingColumn(column);
    startXRef.current = startX;
    // Snapshot ALL widths at drag start for proportional calculation
    startWidthsRef.current = { ...columnWidthsRef.current };

    // Calculate scale factor: rendered width / specified width
    // This compensates for table-layout:fixed + width:100% scaling columns
    const renderedWidth = headerElement.getBoundingClientRect().width;
    const specifiedWidth = columnWidthsRef.current[column];
    scaleFactorRef.current = renderedWidth / specifiedWidth;
  }, []);

  useEffect(() => {
    if (!resizingColumn) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Divide by scale factor to convert screen pixels to logical column width pixels
      const delta = (e.clientX - startXRef.current) / scaleFactorRef.current;
      const visibleKeys = visibleKeysRef.current;
      const startWidths = startWidthsRef.current;

      // Find separator position - the column whose handle is being dragged
      const separatorIndex = visibleKeys.indexOf(resizingColumn);
      if (separatorIndex === -1) return;

      // Get the two adjacent columns: left (owns the separator) and right (next column)
      const leftColumn = visibleKeys[separatorIndex];
      const rightColumn = visibleKeys[separatorIndex + 1];

      // If no right column, nothing to resize against
      if (!rightColumn) return;

      const leftStart = startWidths[leftColumn];
      const rightStart = startWidths[rightColumn];

      // Clamp delta to respect min/max constraints for both columns
      const maxDelta = Math.min(
        MAX_WIDTHS[leftColumn] - leftStart,
        rightStart - MIN_WIDTHS[rightColumn]
      );
      const minDelta = Math.max(
        MIN_WIDTHS[leftColumn] - leftStart,
        rightStart - MAX_WIDTHS[rightColumn]
      );
      const clampedDelta = Math.max(minDelta, Math.min(maxDelta, delta));

      // Update only the two adjacent columns
      setColumnWidths((prev) => ({
        ...prev,
        [leftColumn]: Math.round(leftStart + clampedDelta),
        [rightColumn]: Math.round(rightStart - clampedDelta),
      }));
    };

    const handleMouseUp = () => {
      // Save to localStorage
      setColumnWidths((current) => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
        return current;
      });
      setResizingColumn(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    // Prevent text selection during resize
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [resizingColumn]);

  const resetColumnWidths = useCallback(() => {
    setColumnWidths(DEFAULT_WIDTHS);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const getColumnStyle = useCallback(
    (column: ColumnKey): React.CSSProperties => ({
      width: columnWidths[column],
      minWidth: MIN_WIDTHS[column],
      maxWidth: MAX_WIDTHS[column],
    }),
    [columnWidths]
  );

  return {
    columnWidths,
    isResizing: resizingColumn !== null,
    resizingColumn,
    startResize,
    resetColumnWidths,
    getColumnStyle,
  };
}
