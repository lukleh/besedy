"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useOnlineStatus } from "./use-online-status";
import {
  syncCatalogBackground,
  type BackgroundSyncProgress,
} from "@/lib/offline/sync-manager";

/**
 * Hook return type
 */
export interface UseBackgroundSyncResult {
  /** Current sync progress */
  progress: BackgroundSyncProgress | null;
  /** Start sync for a catalog */
  startSync: (forceRefresh?: boolean) => void;
  /** Cancel ongoing sync */
  cancelSync: () => void;
  /** Is sync in progress? */
  isSyncing: boolean;
  /** Is sync complete? */
  isComplete: boolean;
}

/**
 * Hook for managing background catalog sync.
 *
 * Automatically syncs all catalog metadata to IndexedDB when online.
 * Supports cancellation, resuming interrupted syncs, and progress tracking.
 *
 * @param catalogId - The catalog to sync, or null to skip
 */
export function useBackgroundSync(catalogId: string | null): UseBackgroundSyncResult {
  const { isOnline } = useOnlineStatus();
  const [progress, setProgress] = useState<BackgroundSyncProgress | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const syncingCatalogRef = useRef<string | null>(null);

  // Cancel any ongoing sync
  const cancelSync = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    syncingCatalogRef.current = null;
  }, []);

  // Start sync
  const startSync = useCallback(
    async (forceRefresh = false) => {
      if (!catalogId || !isOnline) return;

      // Cancel any existing sync
      cancelSync();

      // Reset progress when starting a new sync for a different catalog
      if (syncingCatalogRef.current !== catalogId) {
        setProgress(null);
      }

      // Create new abort controller
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      syncingCatalogRef.current = catalogId;

      try {
        await syncCatalogBackground({
          catalogId,
          onProgress: (newProgress) => {
            // Only update if still syncing the same catalog
            if (syncingCatalogRef.current === catalogId) {
              setProgress(newProgress);
            }
          },
          signal: abortController.signal,
          forceRefresh,
        });
      } catch (error) {
        // Error already reported via onProgress
        console.error("[useBackgroundSync] Sync failed:", error);
      }
    },
    [catalogId, isOnline, cancelSync]
  );

  // Auto-start sync when catalogId changes and online
  useEffect(() => {
    if (catalogId && isOnline) {
      // Defer to avoid synchronous setState within effect
      queueMicrotask(() => startSync(false));
    }

    // Cancel on unmount or when going offline
    return () => {
      if (!isOnline) {
        cancelSync();
      }
    };
  }, [catalogId, isOnline, startSync, cancelSync]);

  // Cancel on unmount
  useEffect(() => {
    return () => {
      cancelSync();
    };
  }, [cancelSync]);

  // Resume sync when coming back online
  useEffect(() => {
    if (isOnline && catalogId && progress?.status === "paused") {
      // Defer to avoid synchronous setState within effect
      queueMicrotask(() => startSync(false));
    }
  }, [isOnline, catalogId, progress?.status, startSync]);

  return {
    progress,
    startSync,
    cancelSync,
    isSyncing: progress?.status === "syncing",
    isComplete: progress?.status === "complete",
  };
}
