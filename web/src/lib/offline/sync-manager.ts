/**
 * Catalog sync manager for offline mode
 *
 * Syncs catalog entries to IndexedDB as the user browses.
 * This enables offline viewing of the catalog with indicators
 * for what content is cached.
 */

import {
  getOfflineDB,
  type CatalogEntryOffline,
  type CatalogOffline,
  type SyncMetadata,
} from "./db";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";

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

interface PaginationInfo {
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

interface CatalogPageResponse {
  groupLabel: string | null;
  entries: CatalogEntry[];
  pagination: PaginationInfo;
  total: number;
  lastModifiedAt?: string;
}

/**
 * Sync a page of catalog entries to IndexedDB
 *
 * When syncing page 1, clears all existing entries for this catalog first
 * to ensure deleted entries on the server are removed from the cache.
 *
 * Uses atomic flag pattern for data safety: syncInProgress is set true before
 * clearing entries and false only after all data is written. If interrupted,
 * the flag remains true and getOfflineEntries() returns empty array.
 */
export async function syncCatalogPage(
  catalogId: string,
  catalogLabel: string | null,
  entries: CatalogEntry[],
  pagination: PaginationInfo,
  totalEntries: number,
  lastModifiedAt?: string
): Promise<void> {
  const db = await getOfflineDB();
  const now = Date.now();

  // Use a transaction for atomic updates
  const tx = db.transaction(["catalogEntries", "catalogs", "syncMeta"], "readwrite");

  try {
    const entryStore = tx.objectStore("catalogEntries");
    const syncMetaStore = tx.objectStore("syncMeta");

    // On page 1, set syncInProgress flag BEFORE clearing to protect against interruption
    if (pagination.page === 1) {
      const inProgressMeta: SyncMetadata = {
        key: catalogId,
        lastSyncAt: now,
        lastSyncPage: 0,
        totalPages: pagination.totalPages,
        syncComplete: false,
        syncInProgress: true,
      };
      await syncMetaStore.put(inProgressMeta);

      // Now clear all existing entries for this catalog to remove stale data
      const existingKeys = await entryStore.index("byCatalog").getAllKeys(catalogId);
      for (const key of existingKeys) {
        await entryStore.delete(key);
      }
    }

    // Update catalog metadata
    const catalogMeta: CatalogOffline = {
      id: catalogId,
      label: catalogLabel,
      totalEntries,
      syncedAt: now,
      lastModifiedAt,
    };
    await tx.objectStore("catalogs").put(catalogMeta);

    // Store entries
    for (const entry of entries) {
      const offlineEntry: CatalogEntryOffline = {
        hash: entry.hash,
        catalogId,
        title: entry.title ?? undefined,
        curatedTitle: entry.curatedTitle,
        artist: entry.artist ?? undefined,
        curatedArtist: entry.curatedArtist,
        duration: entry.duration ?? undefined,
        dateYear: entry.dateYear,
        dateMonth: entry.dateMonth,
        dateDay: entry.dateDay,
        part: entry.part,
        hasArchived: entry.hasArchived,
        hasMetadata: entry.hasMetadata,
        isActionable: entry.isActionable,
        isPublished: entry.isPublished,
        verified: entry.verified ?? false,
        recorder: entry.recorder,
        location: entry.location,
        album: entry.album,
        syncedAt: now,
      };
      await entryStore.put(offlineEntry);
    }

    // Update sync metadata - clear syncInProgress flag now that data is written
    const syncMeta: SyncMetadata = {
      key: catalogId,
      lastSyncAt: now,
      lastSyncPage: pagination.page,
      totalPages: pagination.totalPages,
      syncComplete: !pagination.hasNextPage,
      syncInProgress: false,
    };
    await syncMetaStore.put(syncMeta);

    await tx.done;
  } catch (error) {
    tx.abort();
    throw error;
  }
}

/**
 * Get offline catalog entries for a specific catalog
 *
 * Returns empty array if a sync is in progress (syncInProgress flag is true)
 * to prevent displaying partial/corrupted data during page 1 sync.
 */
export async function getOfflineEntries(
  catalogId: string
): Promise<CatalogEntryOffline[]> {
  const db = await getOfflineDB();

  // Check if sync is in progress - return empty to avoid showing partial data
  const syncMeta = await db.get("syncMeta", catalogId);
  if (syncMeta?.syncInProgress) {
    return [];
  }

  return db.getAllFromIndex("catalogEntries", "byCatalog", catalogId);
}

/**
 * Get catalog metadata
 */
export async function getCatalogMeta(catalogId: string): Promise<CatalogOffline | undefined> {
  const db = await getOfflineDB();
  return db.get("catalogs", catalogId);
}

/**
 * Get sync status for a catalog
 */
export async function getSyncStatus(catalogId: string): Promise<SyncMetadata | undefined> {
  const db = await getOfflineDB();
  return db.get("syncMeta", catalogId);
}

/**
 * Check if catalog data is available offline
 */
export async function isCatalogOfflineAvailable(catalogId: string): Promise<boolean> {
  const meta = await getCatalogMeta(catalogId);
  return meta !== undefined && meta.totalEntries > 0;
}

/**
 * Get offline entries count for a catalog
 */
export async function getOfflineEntriesCount(catalogId: string): Promise<number> {
  const db = await getOfflineDB();
  const entries = await db.getAllKeysFromIndex("catalogEntries", "byCatalog", catalogId);
  return entries.length;
}

/**
 * Clear all offline data for a catalog
 */
export async function clearCatalogOfflineData(catalogId: string): Promise<void> {
  const db = await getOfflineDB();
  const tx = db.transaction(["catalogEntries", "catalogs", "syncMeta"], "readwrite");

  try {
    // Delete all entries for this catalog
    const entries = await tx.objectStore("catalogEntries")
      .index("byCatalog")
      .getAllKeys(catalogId);

    for (const key of entries) {
      await tx.objectStore("catalogEntries").delete(key);
    }

    // Delete catalog metadata
    await tx.objectStore("catalogs").delete(catalogId);

    // Delete sync metadata
    await tx.objectStore("syncMeta").delete(catalogId);

    await tx.done;
  } catch (error) {
    tx.abort();
    throw error;
  }
}

/**
 * Clear all offline data
 */
export async function clearAllOfflineData(): Promise<void> {
  const db = await getOfflineDB();
  const tx = db.transaction(["catalogEntries", "catalogs", "syncMeta", "contentCache"], "readwrite");

  try {
    await tx.objectStore("catalogEntries").clear();
    await tx.objectStore("catalogs").clear();
    await tx.objectStore("syncMeta").clear();
    await tx.objectStore("contentCache").clear();
    await tx.done;
  } catch (error) {
    tx.abort();
    throw error;
  }
}

/**
 * Background sync progress
 */
export interface BackgroundSyncProgress {
  currentPage: number;
  totalPages: number;
  entriesSynced: number;
  totalEntries: number;
  status: "idle" | "syncing" | "complete" | "error" | "paused";
  error?: string;
  /** Server's lastModifiedAt timestamp (available on complete) */
  lastModifiedAt?: string;
}

/**
 * Background sync options
 */
export interface BackgroundSyncOptions {
  catalogId: string;
  onProgress: (progress: BackgroundSyncProgress) => void;
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

// Staleness threshold: 1 hour
const STALE_THRESHOLD_MS = 60 * 60 * 1000;

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

// Delay between pages to avoid overwhelming the server
const PAGE_DELAY_MS = 100;

/**
 * Fetch with exponential backoff retry
 */
async function fetchWithRetry<T>(
  url: string,
  signal?: AbortSignal,
  retryCount = 0
): Promise<T> {
  try {
    return await fetchJson<T>(url, { signal });
  } catch (error) {
    // Don't retry if aborted
    if (signal?.aborted) {
      throw error;
    }

    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      throw error;
    }

    if (retryCount >= MAX_RETRIES) {
      throw error;
    }

    const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return fetchWithRetry(url, signal, retryCount + 1);
  }
}

/**
 * Check if catalog needs to be synced
 */
async function shouldSync(catalogId: string, forceRefresh?: boolean): Promise<{ shouldSync: boolean; startPage: number }> {
  if (forceRefresh) {
    return { shouldSync: true, startPage: 1 };
  }

  const syncMeta = await getSyncStatus(catalogId);

  // Never synced
  if (!syncMeta) {
    return { shouldSync: true, startPage: 1 };
  }

  // Incomplete sync - resume from where we left off
  if (!syncMeta.syncComplete) {
    return { shouldSync: true, startPage: syncMeta.lastSyncPage + 1 };
  }

  // Check staleness
  const age = Date.now() - syncMeta.lastSyncAt;
  if (age > STALE_THRESHOLD_MS) {
    return { shouldSync: true, startPage: 1 };
  }

  // Already synced and fresh
  return { shouldSync: false, startPage: 0 };
}

/**
 * Sync all catalog pages in background
 *
 * Fetches all pages sequentially and stores them in IndexedDB.
 * Supports resuming from interrupted syncs and cancellation via AbortSignal.
 */
export async function syncCatalogBackground(options: BackgroundSyncOptions): Promise<void> {
  const { catalogId, onProgress, signal, forceRefresh } = options;

  // Check if we need to sync
  const { shouldSync: needsSync, startPage } = await shouldSync(catalogId, forceRefresh);

  if (!needsSync) {
    // Already synced and fresh - report current state
    const meta = await getCatalogMeta(catalogId);
    const count = await getOfflineEntriesCount(catalogId);
    onProgress({
      currentPage: 0,
      totalPages: 0,
      entriesSynced: count,
      totalEntries: meta?.totalEntries ?? count,
      status: "complete",
      lastModifiedAt: meta?.lastModifiedAt,
    });
    return;
  }

  let currentPage = startPage;
  let totalPages = 0;
  let totalEntries = 0;
  let entriesSynced = 0;
  let lastModifiedAt: string | undefined;

  // If resuming, get existing count
  if (startPage > 1) {
    entriesSynced = await getOfflineEntriesCount(catalogId);
  }

  try {
    while (true) {
      // Check for cancellation
      if (signal?.aborted) {
        onProgress({
          currentPage,
          totalPages,
          entriesSynced,
          totalEntries,
          status: "paused",
        });
        return;
      }

      // Report progress
      onProgress({
        currentPage,
        totalPages: totalPages || currentPage, // Use current page if we don't know total yet
        entriesSynced,
        totalEntries: totalEntries || entriesSynced,
        status: "syncing",
      });

      // Fetch page
      const url = `/api/catalog?group=${encodeURIComponent(catalogId)}&page=${currentPage}&limit=50`;
      const data = await fetchWithRetry<CatalogPageResponse>(url, signal);

      // Update totals from response
      totalPages = data.pagination.totalPages;
      totalEntries = data.total;
      lastModifiedAt = data.lastModifiedAt;

      // Store page in IndexedDB
      await syncCatalogPage(
        catalogId,
        data.groupLabel,
        data.entries,
        data.pagination,
        data.total,
        lastModifiedAt
      );

      // Update synced count
      entriesSynced += data.entries.length;

      // Check if we're done
      if (!data.pagination.hasNextPage) {
        break;
      }

      // Move to next page
      currentPage++;

      // Small delay to avoid overwhelming the server
      if (PAGE_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
      }
    }

    // Sync complete
    onProgress({
      currentPage,
      totalPages,
      entriesSynced,
      totalEntries,
      status: "complete",
      lastModifiedAt,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Don't report error if aborted
    if (signal?.aborted) {
      onProgress({
        currentPage,
        totalPages,
        entriesSynced,
        totalEntries,
        status: "paused",
      });
      return;
    }

    onProgress({
      currentPage,
      totalPages,
      entriesSynced,
      totalEntries,
      status: "error",
      error: errorMessage,
    });

    throw error;
  }
}
