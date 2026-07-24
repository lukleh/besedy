/**
 * IndexedDB wrapper for offline catalog and cache status storage
 */
import { openDB, DBSchema, IDBPDatabase } from "idb";

const DB_NAME = "besedy-offline";
const DB_VERSION = 1;

/**
 * Catalog entry stored in IndexedDB
 * Subset of CatalogEntry from catalog-list/types.ts
 */
export interface CatalogEntryOffline {
  hash: string;
  catalogId: string;
  filename?: string;
  title?: string;
  curatedTitle?: string | null;
  artist?: string;
  curatedArtist?: string | null;
  duration?: string;
  date?: string;
  curatedDate?: string | null;
  dateYear?: number | null;
  dateMonth?: number | null;
  dateDay?: number | null;
  part?: number | null;
  recorder?: { id: number; name: string } | null;
  location?: { id: number; name: string } | null;
  album?: { id: number; name: string } | null;
  hasArchived: boolean;
  hasMetadata: boolean;
  isActionable: boolean;
  isPublished: boolean;
  verified?: boolean;
  duplicateCount?: number;
  // Sync metadata
  syncedAt: number;
}

/**
 * Catalog (workflow group) metadata
 */
export interface CatalogOffline {
  id: string;
  label: string | null;
  totalEntries: number;
  syncedAt: number;
  /** Server's lastModifiedAt timestamp for staleness comparison */
  lastModifiedAt?: string;
}

/**
 * Content cache status (audio + transcript)
 */
export interface ContentCacheStatus {
  hash: string;
  audioStatus: "none" | "downloading" | "complete";
  audioProgress: number;
  audioSize?: number;
  audioVariant?: string;
  transcriptStatus: "none" | "downloading" | "complete";
  transcriptBackend?: string;
  transcriptSize?: number;
  speakersStatus: "none" | "complete";
  speakersBackend?: string;
  cachedAt?: number;
  lastAccessedAt?: number;
}

/**
 * Sync metadata for tracking catalog sync progress
 */
export interface SyncMetadata {
  key: string;
  lastSyncAt: number;
  lastSyncPage: number;
  totalPages: number;
  syncComplete: boolean;
  /** True while page 1 sync is in progress (data being cleared/replaced) */
  syncInProgress?: boolean;
}

/**
 * IndexedDB schema definition
 */
interface OfflineDBSchema extends DBSchema {
  catalogEntries: {
    key: [string, string]; // [catalogId, hash]
    value: CatalogEntryOffline;
    indexes: {
      byCatalog: string;
      byHash: string;
      bySyncTime: number;
    };
  };
  catalogs: {
    key: string;
    value: CatalogOffline;
  };
  contentCache: {
    key: string;
    value: ContentCacheStatus;
  };
  syncMeta: {
    key: string;
    value: SyncMetadata;
  };
}

let dbPromise: Promise<IDBPDatabase<OfflineDBSchema>> | null = null;

/**
 * Get or create the offline database
 */
export async function getOfflineDB(): Promise<IDBPDatabase<OfflineDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<OfflineDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Catalog entries store
        if (!db.objectStoreNames.contains("catalogEntries")) {
          const store = db.createObjectStore("catalogEntries", {
            keyPath: ["catalogId", "hash"],
          });
          store.createIndex("byCatalog", "catalogId");
          store.createIndex("byHash", "hash");
          store.createIndex("bySyncTime", "syncedAt");
        }

        // Catalogs store
        if (!db.objectStoreNames.contains("catalogs")) {
          db.createObjectStore("catalogs", { keyPath: "id" });
        }

        // Content cache status store
        if (!db.objectStoreNames.contains("contentCache")) {
          db.createObjectStore("contentCache", { keyPath: "hash" });
        }

        // Sync metadata store
        if (!db.objectStoreNames.contains("syncMeta")) {
          db.createObjectStore("syncMeta", { keyPath: "key" });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Check if IndexedDB is available
 */
export function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

// =============================================================================
// Catalog Entries Operations
// =============================================================================

/**
 * Store catalog entries in IndexedDB
 */
export async function storeCatalogEntries(
  catalogId: string,
  entries: Omit<CatalogEntryOffline, "catalogId" | "syncedAt">[]
): Promise<void> {
  const db = await getOfflineDB();
  const tx = db.transaction("catalogEntries", "readwrite");
  const now = Date.now();

  for (const entry of entries) {
    await tx.store.put({
      ...entry,
      catalogId,
      syncedAt: now,
    });
  }

  await tx.done;
}

/**
 * Get all catalog entries for a catalog from IndexedDB
 */
export async function getCatalogEntries(
  catalogId: string
): Promise<CatalogEntryOffline[]> {
  const db = await getOfflineDB();
  return db.getAllFromIndex("catalogEntries", "byCatalog", catalogId);
}

/**
 * Get a single catalog entry by hash
 */
export async function getCatalogEntry(
  catalogId: string,
  hash: string
): Promise<CatalogEntryOffline | undefined> {
  const db = await getOfflineDB();
  return db.get("catalogEntries", [catalogId, hash]);
}

/**
 * Delete all entries for a catalog
 */
export async function clearCatalogEntries(catalogId: string): Promise<void> {
  const db = await getOfflineDB();
  const entries = await db.getAllFromIndex("catalogEntries", "byCatalog", catalogId);
  const tx = db.transaction("catalogEntries", "readwrite");

  for (const entry of entries) {
    await tx.store.delete([entry.catalogId, entry.hash]);
  }

  await tx.done;
}

// =============================================================================
// Catalogs Operations
// =============================================================================

/**
 * Store catalog metadata
 */
export async function storeCatalog(catalog: CatalogOffline): Promise<void> {
  const db = await getOfflineDB();
  await db.put("catalogs", catalog);
}

/**
 * Get all stored catalogs
 */
export async function getCatalogs(): Promise<CatalogOffline[]> {
  const db = await getOfflineDB();
  return db.getAll("catalogs");
}

/**
 * Get a single catalog by ID
 */
export async function getCatalog(id: string): Promise<CatalogOffline | undefined> {
  const db = await getOfflineDB();
  return db.get("catalogs", id);
}

// =============================================================================
// Content Cache Status Operations
// =============================================================================

/**
 * Update content cache status
 */
export async function updateContentCacheStatus(
  status: ContentCacheStatus
): Promise<void> {
  const db = await getOfflineDB();
  await db.put("contentCache", status);
}

/**
 * Get content cache status for a hash
 */
export async function getContentCacheStatus(
  hash: string
): Promise<ContentCacheStatus | undefined> {
  const db = await getOfflineDB();
  return db.get("contentCache", hash);
}

/**
 * Get all content cache statuses
 */
export async function getAllContentCacheStatuses(): Promise<ContentCacheStatus[]> {
  const db = await getOfflineDB();
  return db.getAll("contentCache");
}

/**
 * Delete content cache status
 */
export async function deleteContentCacheStatus(hash: string): Promise<void> {
  const db = await getOfflineDB();
  await db.delete("contentCache", hash);
}

/**
 * Get all hashes that have content cached (audio complete)
 */
export async function getCachedHashes(): Promise<Set<string>> {
  const statuses = await getAllContentCacheStatuses();
  const cached = new Set<string>();

  for (const status of statuses) {
    if (status.audioStatus === "complete") {
      cached.add(status.hash);
    }
  }

  return cached;
}

// =============================================================================
// Sync Metadata Operations
// =============================================================================

/**
 * Update sync metadata
 */
export async function updateSyncMetadata(meta: SyncMetadata): Promise<void> {
  const db = await getOfflineDB();
  await db.put("syncMeta", meta);
}

/**
 * Get sync metadata for a catalog
 */
export async function getSyncMetadata(
  catalogId: string
): Promise<SyncMetadata | undefined> {
  const db = await getOfflineDB();
  return db.get("syncMeta", catalogId);
}

// =============================================================================
// Utility Operations
// =============================================================================

/**
 * Clear all offline data
 */
export async function clearAllOfflineData(): Promise<void> {
  const db = await getOfflineDB();
  const tx = db.transaction(
    ["catalogEntries", "catalogs", "contentCache", "syncMeta"],
    "readwrite"
  );

  await tx.objectStore("catalogEntries").clear();
  await tx.objectStore("catalogs").clear();
  await tx.objectStore("contentCache").clear();
  await tx.objectStore("syncMeta").clear();

  await tx.done;
}

/**
 * Get storage usage estimate for offline data
 */
export async function getOfflineStorageSize(): Promise<{
  entries: number;
  catalogs: number;
  cacheStatuses: number;
}> {
  const db = await getOfflineDB();

  const entries = await db.count("catalogEntries");
  const catalogs = await db.count("catalogs");
  const cacheStatuses = await db.count("contentCache");

  return { entries, catalogs, cacheStatuses };
}
