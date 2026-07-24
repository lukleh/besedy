"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { fetchJson } from "@/lib/api/fetch-json";

/**
 * Metadata fields that can be edited inline in the catalog table.
 */
export interface EditableMetadata {
  title?: string | null;
  artist?: string | null;
  albumId?: number | null;
  dateYear?: number | null;
  dateMonth?: number | null;
  dateDay?: number | null;
  recorderId?: number | null;
  locationId?: number | null;
  part?: number | null;
  verified?: boolean;
}

export type EditableField = keyof EditableMetadata;

/**
 * Result of a save operation for a single recording.
 */
export interface SaveResult {
  hash: string;
  success: boolean;
  error?: string;
}

/**
 * Currently active cell being edited.
 */
export interface ActiveCell {
  hash: string;
  field: EditableField;
}

export interface UseInlineEditOptions {
  catalogId: string;
  onSaveSuccess?: () => void;
  onSaveError?: (errors: SaveResult[]) => void;
}

export interface UseInlineEditReturn {
  /** Whether edit mode is currently active */
  isEditMode: boolean;
  /** Toggle edit mode on/off */
  toggleEditMode: () => void;
  /** Exit edit mode (with optional force to skip unsaved check) */
  exitEditMode: (force?: boolean) => boolean;
  /** Map of hash -> field changes */
  pendingChanges: Map<string, Partial<EditableMetadata>>;
  /** Whether there are any unsaved changes */
  hasUnsavedChanges: boolean;
  /** Number of modified rows */
  modifiedCount: number;
  /** Update a field value for a recording */
  updateField: (hash: string, field: EditableField, value: unknown) => void;
  /** Discard a single pending field edit (used when a cell edit is cancelled) */
  revertField: (hash: string, field: EditableField) => void;
  /** Get the current value for a cell (pending or original) */
  getCellValue: <T>(hash: string, field: EditableField, original: T) => T;
  /** Check if a specific cell or entire row has been modified */
  isModified: (hash: string, field?: EditableField) => boolean;
  /** Save all pending changes */
  saveAllChanges: () => Promise<SaveResult[]>;
  /** Discard all pending changes */
  discardChanges: () => void;
  /** Whether a save operation is in progress */
  isSaving: boolean;
  /** Currently active cell being edited */
  activeCell: ActiveCell | null;
  /** Set the active cell */
  setActiveCell: (cell: ActiveCell | null) => void;
  /** Clear active cell only if it matches the given cell (prevents race conditions) */
  clearActiveCell: (cell: ActiveCell) => void;
  /** Errors from last save attempt, keyed by hash */
  saveErrors: Map<string, string>;
  /** Whether the unsaved changes dialog should be shown */
  showUnsavedDialog: boolean;
  /** Confirm leaving edit mode (discards changes) */
  confirmDiscard: () => void;
  /** Cancel leaving edit mode */
  cancelDiscard: () => void;
}

/**
 * Hook for managing inline editing state in the catalog table.
 */
export function useInlineEdit({
  catalogId,
  onSaveSuccess,
  onSaveError,
}: UseInlineEditOptions): UseInlineEditReturn {
  const [isEditMode, setIsEditMode] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<Map<string, Partial<EditableMetadata>>>(
    new Map()
  );
  const [isSaving, setIsSaving] = useState(false);
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const [saveErrors, setSaveErrors] = useState<Map<string, string>>(new Map());
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);

  // Mirror of pendingChanges, kept current after each commit and updated
  // inline by revertField. It lets revertField decide whether a row became
  // fully unmodified across the burst of calls a date cell makes (year/month/
  // day) without reading a stale render snapshot. It only drives that
  // decision — the authoritative state write below is a functional updater.
  const pendingChangesRef = useRef(pendingChanges);
  useEffect(() => {
    pendingChangesRef.current = pendingChanges;
  }, [pendingChanges]);

  const hasUnsavedChanges = pendingChanges.size > 0;
  const modifiedCount = pendingChanges.size;

  const toggleEditMode = useCallback(() => {
    if (isEditMode && hasUnsavedChanges) {
      // Show unsaved changes dialog
      setShowUnsavedDialog(true);
    } else {
      setIsEditMode((prev) => !prev);
      if (isEditMode) {
        // Exiting edit mode, clear state
        setActiveCell(null);
        setSaveErrors(new Map());
      }
    }
  }, [isEditMode, hasUnsavedChanges]);

  const exitEditMode = useCallback(
    (force = false): boolean => {
      if (!force && hasUnsavedChanges) {
        setShowUnsavedDialog(true);
        return false;
      }
      setIsEditMode(false);
      setActiveCell(null);
      setSaveErrors(new Map());
      if (force) {
        setPendingChanges(new Map());
      }
      return true;
    },
    [hasUnsavedChanges]
  );

  const confirmDiscard = useCallback(() => {
    setShowUnsavedDialog(false);
    setPendingChanges(new Map());
    setIsEditMode(false);
    setActiveCell(null);
    setSaveErrors(new Map());
  }, []);

  const cancelDiscard = useCallback(() => {
    setShowUnsavedDialog(false);
  }, []);

  const updateField = useCallback(
    (hash: string, field: EditableField, value: unknown) => {
      setPendingChanges((prev) => {
        const newMap = new Map(prev);
        const existing = newMap.get(hash) || {};
        const updated = { ...existing, [field]: value };

        // Check if all values are back to their original (not tracked here, handled elsewhere)
        // For now, just update
        newMap.set(hash, updated);
        return newMap;
      });
      // Clear any previous error for this hash
      setSaveErrors((prev) => {
        if (prev.has(hash)) {
          const newMap = new Map(prev);
          newMap.delete(hash);
          return newMap;
        }
        return prev;
      });
    },
    []
  );

  const revertField = useCallback((hash: string, field: EditableField) => {
    const existing = pendingChangesRef.current.get(hash);
    if (!existing || !(field in existing)) {
      return;
    }
    const updatedRow = { ...existing };
    delete updatedRow[field];
    const rowBecameClean = Object.keys(updatedRow).length === 0;

    // Advance the ref so a following revert in the same burst (date
    // year/month/day) sees this removal when deciding rowBecameClean.
    const nextChanges = new Map(pendingChangesRef.current);
    if (rowBecameClean) {
      nextChanges.delete(hash);
    } else {
      nextChanges.set(hash, updatedRow);
    }
    pendingChangesRef.current = nextChanges;

    // Authoritative write via a functional updater so it can never clobber a
    // concurrently queued update.
    setPendingChanges((prev) => {
      const cur = prev.get(hash);
      if (!cur || !(field in cur)) {
        return prev;
      }
      const updated = { ...cur };
      delete updated[field];
      const newMap = new Map(prev);
      if (Object.keys(updated).length === 0) {
        newMap.delete(hash);
      } else {
        newMap.set(hash, updated);
      }
      return newMap;
    });

    // Only clear the save error once the whole row is back to unmodified —
    // reverting one field must not hide an error for other still-changed
    // fields in the same row.
    if (rowBecameClean) {
      setSaveErrors((prev) => {
        if (!prev.has(hash)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(hash);
        return next;
      });
    }
  }, []);

  const getCellValue = useCallback(
    <T,>(hash: string, field: EditableField, original: T): T => {
      const changes = pendingChanges.get(hash);
      if (changes && field in changes) {
        return changes[field] as T;
      }
      return original;
    },
    [pendingChanges]
  );

  const isModified = useCallback(
    (hash: string, field?: EditableField): boolean => {
      const changes = pendingChanges.get(hash);
      if (!changes) return false;
      if (field) {
        return field in changes;
      }
      return Object.keys(changes).length > 0;
    },
    [pendingChanges]
  );

  const saveAllChanges = useCallback(async (): Promise<SaveResult[]> => {
    if (pendingChanges.size === 0) {
      return [];
    }

    setIsSaving(true);
    setSaveErrors(new Map());

    const results: SaveResult[] = [];
    const newErrors = new Map<string, string>();

    // Save each modified row
    const entries = Array.from(pendingChanges.entries());
    const promises = entries.map(async ([hash, changes]) => {
      try {
        await fetchJson(`/api/catalogs/${catalogId}/recordings/${hash}/metadata`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(changes),
        });

        return { hash, success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Network error";
        newErrors.set(hash, errorMessage);
        return { hash, success: false, error: errorMessage };
      }
    });

    const settledResults = await Promise.allSettled(promises);
    for (const result of settledResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      }
    }

    // Remove successful changes from pending
    const successfulHashes = new Set(
      results.filter((r) => r.success).map((r) => r.hash)
    );
    setPendingChanges((prev) => {
      const newMap = new Map(prev);
      for (const hash of successfulHashes) {
        newMap.delete(hash);
      }
      return newMap;
    });

    setSaveErrors(newErrors);
    setIsSaving(false);

    // Call callbacks
    const failedResults = results.filter((r) => !r.success);
    if (failedResults.length === 0) {
      onSaveSuccess?.();
      // Exit edit mode if all saves succeeded
      setIsEditMode(false);
      setActiveCell(null);
    } else {
      onSaveError?.(failedResults);
    }

    return results;
  }, [catalogId, pendingChanges, onSaveSuccess, onSaveError]);

  const discardChanges = useCallback(() => {
    setPendingChanges(new Map());
    setSaveErrors(new Map());
  }, []);

  // Clear active cell only if it matches the given cell.
  // This prevents race conditions when clicking from one cell to another -
  // the blur handler's deferred clear won't overwrite the new cell.
  const clearActiveCell = useCallback((cell: ActiveCell) => {
    setActiveCell((current) => {
      if (current?.hash === cell.hash && current?.field === cell.field) {
        return null;
      }
      return current;
    });
  }, []);

  return useMemo(
    () => ({
      isEditMode,
      toggleEditMode,
      exitEditMode,
      pendingChanges,
      hasUnsavedChanges,
      modifiedCount,
      updateField,
      revertField,
      getCellValue,
      isModified,
      saveAllChanges,
      discardChanges,
      isSaving,
      activeCell,
      setActiveCell,
      clearActiveCell,
      saveErrors,
      showUnsavedDialog,
      confirmDiscard,
      cancelDiscard,
    }),
    [
      isEditMode,
      toggleEditMode,
      exitEditMode,
      pendingChanges,
      hasUnsavedChanges,
      modifiedCount,
      updateField,
      revertField,
      getCellValue,
      isModified,
      saveAllChanges,
      discardChanges,
      isSaving,
      activeCell,
      clearActiveCell,
      saveErrors,
      showUnsavedDialog,
      confirmDiscard,
      cancelDiscard,
    ]
  );
}
