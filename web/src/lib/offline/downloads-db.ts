/**
 * IndexedDB registry of downloads.
 *
 * Lightweight registry rows are the source of truth for download state. Large
 * transcript and poster payloads live in a separate store so listing downloads
 * and persisting progress never reads or rewrites every downloaded transcript.
 * The database name is inherited from the earlier catalog-mirror experiment.
 */
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  Diarization,
  Transcript,
} from '@/components/transcript/transcript-viewer-types';

export const DOWNLOADS_DB_NAME = 'besedy-offline';
const DOWNLOADS_DB_VERSION = 4;
const DOWNLOADS_STORE = 'downloads';
const DOWNLOAD_BUNDLES_STORE = 'downloadBundles';
const PLAYBACK_PROGRESS_STORE = 'pendingPlaybackProgress';

export type DownloadStatus =
  /** Waiting for the queue. */
  | 'queued'
  /** Actively fetching. */
  | 'downloading'
  /** Stopped by the user or by a network failure. */
  | 'paused'
  /** Stopped by a non-network error (HTTP status, storage); retry on demand. */
  | 'error'
  | 'complete';

export interface DownloadEventSnapshot {
  id: number;
  title: string | null;
  locationName: string | null;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
  sessionIndex: number;
  /** Absent on records downloaded before ordinals were stored; the cue hides then. */
  sessionOrdinal?: number;
  sessionCount?: number;
  publishedPoster: {
    id: string;
    publishedAt: string;
  } | null;
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
  catalogLabel: string | null;
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
  /** Network pauses resume on reconnect; explicit user pauses do not. */
  resumeOnReconnect: boolean;
  transcriptBackend: string | null;
  hasPoster: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface DownloadPosterPayload {
  blob: Blob;
  contentType: string;
  /** `portrait` is retained only for bundles created before ADR 0009. */
  variant: 'square' | 'landscape' | 'portrait';
  posterId?: string;
}

export interface DownloadInlineAudioPayload {
  data: ArrayBuffer;
  contentType: string;
}

export interface DownloadBundlePayload {
  /** Same `${catalogId}:${hash}` key as the lightweight registry row. */
  key: string;
  transcriptBackend: string | null;
  transcript: Transcript | null;
  diarization: Diarization | null;
  poster: DownloadPosterPayload | null;
  /** WebKit-compatible copy; older bundles and non-WebKit browsers omit it. */
  inlineAudio?: DownloadInlineAudioPayload | null;
  updatedAt: number;
}

export interface PendingPlaybackProgress {
  /** `${userId}:${catalogId}:${hash}` */
  key: string;
  userId: string;
  catalogId: string;
  hash: string;
  positionSec: number;
  durationSec: number | null;
  completed: boolean;
  /** Monotonic per-recording revision used for compare-and-delete after sync. */
  revision: number;
  updatedAt: number;
}

export interface PendingPlaybackProgressInput {
  userId: string;
  catalogId: string;
  hash: string;
  positionSec: number;
  durationSec: number | null;
  completed: boolean;
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
  downloadBundles: {
    key: string;
    value: DownloadBundlePayload;
  };
  pendingPlaybackProgress: {
    key: string;
    value: PendingPlaybackProgress;
    indexes: { byUser: string };
  };
}

export function makeDownloadKey(catalogId: string, hash: string): string {
  return `${catalogId}:${hash}`;
}

export function makeEventKey(catalogId: string, eventId: number): string {
  return `${catalogId}:${eventId}`;
}

export function makePendingPlaybackProgressKey(
  userId: string,
  catalogId: string,
  hash: string,
): string {
  return `${userId}:${catalogId}:${hash}`;
}

export function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

let dbPromise: Promise<IDBPDatabase<DownloadsDBSchema>> | null = null;

export function getDownloadsDB(): Promise<IDBPDatabase<DownloadsDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<DownloadsDBSchema>(
      DOWNLOADS_DB_NAME,
      DOWNLOADS_DB_VERSION,
      {
        upgrade(db) {
          for (const name of Array.from(db.objectStoreNames)) {
            if (
              name !== DOWNLOADS_STORE &&
              name !== DOWNLOAD_BUNDLES_STORE &&
              name !== PLAYBACK_PROGRESS_STORE
            ) {
              db.deleteObjectStore(name);
            }
          }
          if (!db.objectStoreNames.contains(DOWNLOADS_STORE)) {
            const store = db.createObjectStore(DOWNLOADS_STORE, {
              keyPath: 'key',
            });
            store.createIndex('byCatalog', 'catalogId');
            store.createIndex('byEventKey', 'eventKey');
            store.createIndex('byStatus', 'status');
          }
          if (!db.objectStoreNames.contains(DOWNLOAD_BUNDLES_STORE)) {
            db.createObjectStore(DOWNLOAD_BUNDLES_STORE, { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains(PLAYBACK_PROGRESS_STORE)) {
            const store = db.createObjectStore(PLAYBACK_PROGRESS_STORE, {
              keyPath: 'key',
            });
            store.createIndex('byUser', 'userId');
          }
        },
        blocking() {
          // Another tab is upgrading; release our connection so it can proceed.
          void dbPromise?.then((db) => db.close());
          dbPromise = null;
        },
      },
    );
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

export async function getDownload(
  key: string,
): Promise<DownloadRecord | undefined> {
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

export async function getDownloadBundle(
  key: string,
): Promise<DownloadBundlePayload | undefined> {
  const db = await getDownloadsDB();
  return db.get(DOWNLOAD_BUNDLES_STORE, key);
}

export async function putDownloadBundle(
  bundle: DownloadBundlePayload,
): Promise<void> {
  const db = await getDownloadsDB();
  await db.put(DOWNLOAD_BUNDLES_STORE, bundle);
}

export async function deleteDownloadBundle(key: string): Promise<void> {
  const db = await getDownloadsDB();
  await db.delete(DOWNLOAD_BUNDLES_STORE, key);
}

/** Coalesce playback changes into the latest durable state for a recording. */
export async function putPendingPlaybackProgress(
  input: PendingPlaybackProgressInput,
): Promise<PendingPlaybackProgress> {
  const db = await getDownloadsDB();
  const key = makePendingPlaybackProgressKey(
    input.userId,
    input.catalogId,
    input.hash,
  );
  const transaction = db.transaction(PLAYBACK_PROGRESS_STORE, 'readwrite');
  const existing = await transaction.store.get(key);
  const pending: PendingPlaybackProgress = {
    ...input,
    key,
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: Date.now(),
  };
  await transaction.store.put(pending);
  await transaction.done;
  return pending;
}

export async function getPendingPlaybackProgress(
  userId: string,
  catalogId: string,
  hash: string,
): Promise<PendingPlaybackProgress | undefined> {
  const db = await getDownloadsDB();
  return db.get(
    PLAYBACK_PROGRESS_STORE,
    makePendingPlaybackProgressKey(userId, catalogId, hash),
  );
}

export async function listPendingPlaybackProgress(
  userId: string,
): Promise<PendingPlaybackProgress[]> {
  const db = await getDownloadsDB();
  return db.getAllFromIndex(PLAYBACK_PROGRESS_STORE, 'byUser', userId);
}

/**
 * Remove a synced entry only if no newer local playback update replaced it
 * while the request was in flight.
 */
export async function deletePendingPlaybackProgress(
  key: string,
  revision: number,
): Promise<boolean> {
  const db = await getDownloadsDB();
  const transaction = db.transaction(PLAYBACK_PROGRESS_STORE, 'readwrite');
  const current = await transaction.store.get(key);
  if (!current || current.revision !== revision) {
    await transaction.done;
    return false;
  }
  await transaction.store.delete(key);
  await transaction.done;
  return true;
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
