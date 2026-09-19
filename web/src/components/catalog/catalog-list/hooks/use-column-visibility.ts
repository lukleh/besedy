"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import type { ColumnKey } from "../types";
import {
  COLUMNS,
  STORAGE_KEY,
  getDefaultVisibilityForAccess,
  hasNonDefaultColumns as checkNonDefaultColumns,
  loadColumnVisibility,
} from "../constants";

interface UseColumnVisibilityOptions {
  isHydrated: boolean;
  onFilterClear: (key: ColumnKey) => void;
  clearFilters: () => void;
  canSeeUnreleased?: boolean;
  canManageAccess?: boolean;
}

export interface UseColumnVisibilityReturn {
  columnVisibility: Record<ColumnKey, boolean>;
  visibleColumns: typeof COLUMNS;
  visibleColumnKeys: ColumnKey[];
  lastVisibleColumnKey: ColumnKey | undefined;
  toggleColumn: (key: ColumnKey) => void;
  resetColumns: () => void;
  hasNonDefaultColumns: boolean;
}

export function useColumnVisibility({
  isHydrated,
  onFilterClear,
  clearFilters,
  canSeeUnreleased,
  canManageAccess,
}: UseColumnVisibilityOptions): UseColumnVisibilityReturn {
  // Column visibility state - initialize with role-specific defaults, load from localStorage after hydration
  const [columnVisibility, setColumnVisibility] = useState<Record<ColumnKey, boolean>>(() =>
    getDefaultVisibilityForAccess(canSeeUnreleased)
  );

  const loadedRef = useRef(false);
  const prevAccessRef = useRef<boolean | undefined>(undefined);

  // Load column visibility from localStorage after hydration
  // Intentional: hydration from localStorage runs once on mount
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isHydrated || loadedRef.current) return;
    loadedRef.current = true;

    const storedColumns = loadColumnVisibility(canSeeUnreleased);
    const defaults = getDefaultVisibilityForAccess(canSeeUnreleased);
    const hasStoredColumns = COLUMNS.some(col => storedColumns[col.key] !== defaults[col.key]);
    if (hasStoredColumns) {
      setColumnVisibility(storedColumns);
    }
  }, [isHydrated, canSeeUnreleased, canManageAccess]);

  // When canSeeUnreleased changes (e.g., from undefined to actual role), reinitialize
  // but only if user hasn't customized columns (localStorage is empty)
  // Intentional: role-based initialization runs once per role change
  useEffect(() => {
    // Skip first render and skip if canSeeUnreleased hasn't changed
    if (prevAccessRef.current === canSeeUnreleased) return;
    const wasUndefined = prevAccessRef.current === undefined;
    prevAccessRef.current = canSeeUnreleased;

    // Only reinitialize when transitioning from undefined to a real role
    // and only if there are no stored customizations
    if (wasUndefined && (canSeeUnreleased || canManageAccess !== undefined)) {
      const stored = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
      if (!stored) {
        // No stored customizations, apply role-specific defaults
        setColumnVisibility(getDefaultVisibilityForAccess(canSeeUnreleased));
      }
    }
  }, [canSeeUnreleased, canManageAccess]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const visibleColumns = useMemo(
    () => COLUMNS.filter((column) => columnVisibility[column.key]),
    [columnVisibility]
  );

  const visibleColumnKeys = useMemo(
    () => visibleColumns.map((column) => column.key),
    [visibleColumns]
  );

  const lastVisibleColumnKey = visibleColumnKeys[visibleColumnKeys.length - 1];

  // Save column visibility to localStorage, clear filter when hiding column
  const toggleColumn = (key: ColumnKey) => {
    setColumnVisibility((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      // Clear filter when column is hidden
      if (!next[key]) {
        onFilterClear(key);
      }
      return next;
    });
  };

  const resetColumns = () => {
    const defaults = getDefaultVisibilityForAccess(canSeeUnreleased);
    setColumnVisibility(defaults);
    localStorage.removeItem(STORAGE_KEY);
    clearFilters();
  };

  const hasNonDefaultColumns = checkNonDefaultColumns(columnVisibility, canSeeUnreleased);

  return {
    columnVisibility,
    visibleColumns,
    visibleColumnKeys,
    lastVisibleColumnKey,
    toggleColumn,
    resetColumns,
    hasNonDefaultColumns,
  };
}
