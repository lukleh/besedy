/**
 * IndexedDB registry of downloads.
 *
 * One record per downloaded recording. This is the single source of truth for
 * what is downloaded and how far along it is; the caches only hold bytes. The
 * database name is inherited from the earlier catalog-mirror experiment, and
 * the version 2 upgrade drops those stores.
 */
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

export const DOWNLOADS_DB_NAME = "besedy-offline";
const DOWNLOADS_DB_VERSION = 2;
const DOWNLOADS_STORE = "downloads";

export type DownloadStatus =
  /** Waiting for the queue. */
  | "queued"
  /** Actively fetching. */
  | "downloading"
  /** Stopped by the user or by a network failure; resumes on demand or when online. */
  | "paused"
  /** Stopped by a non-network error (HTTP status, storage); retry on demand. */
  | "error"
  | "complete";

export interface DownloadEventSnapshot {
  id: number;
  title: string | null;
  locationName: string | null;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
  sessionIndex: number;
}

export interface DownloadRecordingSnapshot {
  title: string | null;
  artist: string | null;
  durationHms: string | null;
  recorderName: string | null;
  dateYear: number | null;
  dateMonth: number | null;
  dateDay: number | null;
}

export interface DownloadRecord {
  /** `${catalogId}:${hash}` */
  key: string;
  catalogId: string;
  hash: string;
  /** Owner at the time of download; records are hidden from other users. */
  userId: string | null;
  /** `${catalogId}:${eventId}` when the download was started for an event. */
  eventKey: string | null;
  event: DownloadEventSnapshot | null;
  recording: DownloadRecordingSnapshot | null;
  /** Exact URL the player uses, so the worker serves the same variant. */
  audioUrl: string | null;
  audioCacheKey: string | null;
  status: DownloadStatus;
  /** 0-100 */
  progress: number;
  bytesLoaded: number;
  totalBytes: number;
  error: string | null;
  transcriptBackend: string | null;
  hasPoster: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface DownloadsDBSchema extends DBSchema {
  downloads: {
    key: string;
    value: DownloadRecord;
    indexes: {
      byCatalog: string;
      byEventKey: string;
      byStatus: string;
    };
  };
}

export function makeDownloadKey(catalogId: string, hash: string): string {
  return `${catalogId}:${hash}`;
}

export function makeEventKey(catalogId: string, eventId: number): string {
  return `${catalogId}:${eventId}`;
}

export function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

let dbPromise: Promise<IDBPDatabase<DownloadsDBSchema>> | null = null;

export function getDownloadsDB(): Promise<IDBPDatabase<DownloadsDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<DownloadsDBSchema>(DOWNLOADS_DB_NAME, DOWNLOADS_DB_VERSION, {
      upgrade(db) {
        for (const name of Array.from(db.objectStoreNames)) {
          if (name !== DOWNLOADS_STORE) {
            db.deleteObjectStore(name);
          }
        }
        if (!db.objectStoreNames.contains(DOWNLOADS_STORE)) {
          const store = db.createObjectStore(DOWNLOADS_STORE, { keyPath: "key" });
          store.createIndex("byCatalog", "catalogId");
          store.createIndex("byEventKey", "eventKey");
          store.createIndex("byStatus", "status");
        }
      },
      blocking() {
        // Another tab is upgrading; release our connection so it can proceed.
        void dbPromise?.then((db) => db.close());
        dbPromise = null;
      },
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

export async function listDownloads(): Promise<DownloadRecord[]> {
  const db = await getDownloadsDB();
  return db.getAll(DOWNLOADS_STORE);
}

export async function getDownload(key: string): Promise<DownloadRecord | undefined> {
  const db = await getDownloadsDB();
  return db.get(DOWNLOADS_STORE, key);
}

export async function putDownload(record: DownloadRecord): Promise<void> {
  const db = await getDownloadsDB();
  await db.put(DOWNLOADS_STORE, record);
}

export async function deleteDownloadRecord(key: string): Promise<void> {
  const db = await getDownloadsDB();
  await db.delete(DOWNLOADS_STORE, key);
}

export async function clearDownloadRecords(): Promise<void> {
  const db = await getDownloadsDB();
  await db.clear(DOWNLOADS_STORE);
}

/** Drop the whole database. Used on sign-out and in tests. */
export async function destroyDownloadsDatabase(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    db?.close();
    dbPromise = null;
  }
  await deleteDB(DOWNLOADS_DB_NAME);
}
