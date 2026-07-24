"use client";

import { useCallback, useEffect, useState } from "react";
import { useOnlineStatus } from "./use-online-status";
import type { CatalogEntryOffline, CatalogOffline } from "@/lib/offline/db";
import {
  syncCatalogPage,
  getOfflineEntries,
  getCatalogMeta,
  getSyncStatus,
  getOfflineEntriesCount,
} from "@/lib/offline/sync-manager";

interface OfflineDBState {
  /** Whether data has been loaded from IndexedDB */
  isLoaded: boolean;
  /** Offline entries for the current catalog */
  entries: CatalogEntryOffline[];
  /** Catalog metadata */
  catalogMeta: CatalogOffline | null;
  /** Number of synced entries */
  syncedCount: number;
  /** Last synced timestamp */
  lastSyncedAt: number | null;
}

interface PaginationInfo {
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

interface CatalogEntry {
  hash: string;
  title?: string | null;
  curatedTitle?: string | null;
  artist?: string | null;
  curatedArtist?: string | null;
  duration?: string | null;
  dateYear?: number | null;
  dateMonth?: number | null;
  dateDay?: number | null;
  part?: number | null;
  hasArchived: boolean;
  hasMetadata: boolean;
  isActionable: boolean;
  isPublished: boolean;
  curated?: boolean;
  verified?: boolean;
  recorder?: { id: number; name: string } | null;
  location?: { id: number; name: string } | null;
  album?: { id: number; name: string } | null;
}

/**
 * Hook for managing offline catalog data in IndexedDB.
 *
 * Provides:
 * - Automatic sync of catalog entries as user browses
 * - Offline fallback data when network is unavailable
 * - Sync status tracking
 */
export function useOfflineDB(catalogId: string | null) {
  const { isOnline } = useOnlineStatus();
  const [state, setState] = useState<OfflineDBState>({
    isLoaded: false,
    entries: [],
    catalogMeta: null,
    syncedCount: 0,
    lastSyncedAt: null,
  });

  // Load offline data on mount or when going offline
  useEffect(() => {
    if (!catalogId) {
      return;
    }

    const loadOfflineData = async () => {
      try {
        const [entries, meta, syncStatus] = await Promise.all([
          getOfflineEntries(catalogId),
          getCatalogMeta(catalogId),
          getSyncStatus(catalogId),
        ]);

        setState({
          isLoaded: true,
          entries,
          catalogMeta: meta ?? null,
          syncedCount: entries.length,
          lastSyncedAt: syncStatus?.lastSyncAt ?? null,
        });
      } catch (error) {
        console.error("[useOfflineDB] Failed to load offline data:", error);
        setState((prev) => ({ ...prev, isLoaded: true }));
      }
    };

    loadOfflineData();
  }, [catalogId, isOnline]);

  // Derive effective state when no catalogId
  const effectiveState = !catalogId
    ? {
        isLoaded: true,
        entries: [] as CatalogEntryOffline[],
        catalogMeta: null,
        syncedCount: 0,
        lastSyncedAt: null,
      }
    : state;

  // Sync catalog page to IndexedDB
  const syncPage = useCallback(
    async (
      catalogLabel: string | null,
      entries: CatalogEntry[],
      pagination: PaginationInfo,
      totalEntries: number,
      lastModifiedAt?: string
    ) => {
      if (!catalogId || !isOnline) return;

      try {
        await syncCatalogPage(catalogId, catalogLabel, entries, pagination, totalEntries, lastModifiedAt);

        // Update local state with new count
        const newCount = await getOfflineEntriesCount(catalogId);
        setState((prev) => ({
          ...prev,
          syncedCount: newCount,
          lastSyncedAt: Date.now(),
        }));
      } catch (error) {
        console.error("[useOfflineDB] Failed to sync catalog page:", error);
      }
    },
    [catalogId, isOnline]
  );

  // Reload offline entries (useful after going offline)
  const reloadEntries = useCallback(async () => {
    if (!catalogId) return;

    try {
      const entries = await getOfflineEntries(catalogId);
      setState((prev) => ({
        ...prev,
        entries,
        syncedCount: entries.length,
      }));
    } catch (error) {
      console.error("[useOfflineDB] Failed to reload entries:", error);
    }
  }, [catalogId]);

  return {
    ...effectiveState,
    isOnline,
    syncPage,
    reloadEntries,
  };
}
