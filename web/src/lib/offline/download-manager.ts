'use client';

/**
 * Page-side download engine.
 *
 * Downloads a recording (optionally as part of an event) into the offline
 * caches and keeps the IndexedDB registry current. See docs/web/offline.md.
 *
 * Runs in the page rather than in the service worker because browsers stop
 * idle workers after a short time, which is what made long downloads fragile
 * on phones. One download runs at a time; progress is persisted per chunk so an
 * interrupted download resumes where it stopped. A Web Lock keeps a second tab
 * from running the queue at the same time, and a BroadcastChannel lets tabs
 * see each other's changes.
 */
import { createClientLogger } from '@/lib/log/client';
import {
  buildAudioSourcePreferenceUrl,
  buildAudioSourcesUrl,
  buildAudioUrl,
  buildDiarizationBackendsUrl,
  buildDiarizationUrl,
  buildEventDetailUrl,
  buildEventArtworkUrl,
  buildRecordingEntryUrl,
  buildTranscriptBackendsUrl,
  buildTranscriptUrl,
  type AudioSourceOption,
} from '@/lib/api/recording-urls';
import { EVENT_ARTWORK_LANDSCAPE_MEDIA } from '@/lib/event-artwork-media';
import type {
  Diarization,
  Transcript,
} from '@/components/transcript/transcript-viewer-types';
import type {
  CatalogEntryResponse,
  CatalogEntryWithPermissions,
} from '@/types/catalog';
import type { EventDetailResponse, EventRecording } from '@/types/event-detail';
import {
  AUDIO_CHUNK_SIZE,
  audioCacheMetaBytes,
  deleteAudioCacheEntries,
  getAudioCacheKey,
  getAudioChunkKey,
  readCompleteAudioBlob,
  readAudioCacheMeta,
  isConsistentAudioCacheMeta,
  requiresInlineOfflineAudio,
  verifyAudioCache,
  writeAudioCacheMeta,
  type AudioCacheMeta,
} from './audio-cache-format';
import { DOWNLOADS_PATH, OFFLINE_CACHE_NAMES } from './cache-names';
import { isDownloadsShellWarmup } from './downloads-shell';
import {
  deleteDownloadBundle,
  deleteDownloadRecord,
  getDownload,
  getDownloadBundle,
  isIndexedDBAvailable,
  listDownloads,
  makeDownloadKey,
  makeEventKey,
  putDownloadBundle,
  putDownload,
  type DownloadBundlePayload,
  type DownloadEventSnapshot,
  type DownloadArtworkPayload,
  type DownloadRecord,
  type DownloadRecordingSnapshot,
} from './downloads-db';

const logger = createClientLogger('downloads');
const QUEUE_LOCK_NAME = 'besedy-downloads-queue';
const DOWNLOAD_LOCK_PREFIX = 'besedy-download:';
const CHANNEL_NAME = 'besedy-downloads';
const PERSIST_REQUESTED_KEY = 'besedy-storage-persist-requested';
const SERVICE_WORKER_CONTROL_TIMEOUT_MS = 10_000;
/**
 * Stable error code for a completed record whose audio could not be verified
 * in the cache. Downloads translates it; other errors are raw messages.
 */
export const INCOMPLETE_PACKAGE_ERROR = 'incomplete-package';
let downloadsShellWarmPromise: Promise<void> | null = null;

/**
 * Cached chunks are useful only when a controlling service worker can serve
 * them back to an audio element. Cache Storage itself is available before a
 * newly registered worker claims the page, which previously let us mark a
 * download complete even though it could not play offline.
 */
async function ensureOfflinePlaybackWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    throw new Error('Offline playback requires a service worker');
  }
  if (navigator.serviceWorker.controller) return;

  await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
  if (navigator.serviceWorker.controller) return;

  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      window.clearTimeout(timeoutId);
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
    };
    const onChange = () => {
      if (!navigator.serviceWorker.controller) return;
      finish();
      resolve();
    };
    const timeoutId = window.setTimeout(() => {
      finish();
      reject(new Error('Offline playback is still preparing. Please try again.'));
    }, SERVICE_WORKER_CONTROL_TIMEOUT_MS);
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    // Avoid missing a controllerchange between the check above and listener
    // registration.
    onChange();
  });
}

/** Load the real session-free route so its HTML and build graph are cached. */
function warmDownloadsShell(): Promise<void> {
  if (downloadsShellWarmPromise) return downloadsShellWarmPromise;
  if (
    typeof document === 'undefined' ||
    typeof navigator === 'undefined' ||
    navigator.onLine === false ||
    !navigator.serviceWorker ||
    isDownloadsShellWarmup()
  ) {
    return Promise.resolve();
  }

  downloadsShellWarmPromise = navigator.serviceWorker.ready
    .then(
      () =>
        new Promise<void>((resolve) => {
          const frame = document.createElement('iframe');
          const finish = () => {
            window.clearTimeout(timeoutId);
            frame.remove();
            resolve();
          };
          const timeoutId = window.setTimeout(finish, 15_000);
          frame.hidden = true;
          frame.tabIndex = -1;
          frame.setAttribute('aria-hidden', 'true');
          frame.addEventListener('load', finish, { once: true });
          frame.addEventListener('error', finish, { once: true });
          frame.src = `${DOWNLOADS_PATH}?warm=1`;
          document.body.append(frame);
        }),
    )
    .catch((error) => {
      downloadsShellWarmPromise = null;
      logger.debug('Failed to warm Downloads shell', { error });
    });
  return downloadsShellWarmPromise;
}

// ---------------------------------------------------------------------------
// Server response shapes (only the fields the manager reads)
// ---------------------------------------------------------------------------

interface SourcesResponse {
  sources: AudioSourceOption[];
  defaultSource: string;
}

interface PreferenceResponse {
  sourceId: string | null;
}

interface TranscriptBackendsResponse {
  backends: string[];
}

interface DiarizationBackendsResponse {
  backends: string[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DownloadHttpError extends Error {
  status: number;
  url: string;

  constructor(url: string, status: number) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'DownloadHttpError';
    this.status = status;
    this.url = url;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** A dropped connection, as opposed to a server verdict. */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof DownloadHttpError) return false;
  if (isAbortError(error)) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    return true;
  return error instanceof TypeError;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

async function fetchResponse(
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    throw new DownloadHttpError(url, response.status);
  }
  return response;
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetchResponse(url, signal);
  return (await response.json()) as T;
}

/** Like fetchJson but treats server verdicts as "not available". */
async function tryFetchJson<T>(
  url: string,
  signal: AbortSignal,
): Promise<T | null> {
  try {
    return await fetchJson<T>(url, signal);
  } catch (error) {
    if (isAbortError(error) || isNetworkError(error)) throw error;
    logger.debug('Optional resource unavailable', { url, error });
    return null;
  }
}

async function tryFetchArtwork(
  url: string,
  variant: DownloadArtworkPayload['variant'],
  artworkId: string,
  signal: AbortSignal,
): Promise<DownloadArtworkPayload | null> {
  try {
    const response = await fetchResponse(url, signal);
    const blob = await response.blob();
    return {
      blob,
      contentType:
        response.headers.get('content-type') ??
        blob.type ??
        'application/octet-stream',
      variant,
      artworkId,
    };
  } catch (error) {
    if (isAbortError(error) || isNetworkError(error)) throw error;
    logger.debug('Optional resource unavailable', { url, error });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audio chunks
// ---------------------------------------------------------------------------

interface RangeChunk {
  bytes: ArrayBuffer;
  totalSize: number;
  contentType: string;
}

async function fetchRangeChunk(
  url: string,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<RangeChunk> {
  const response = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    headers: { Range: `bytes=${start}-${end}` },
    signal,
  });

  if (response.status === 206) {
    const contentRange = response.headers.get('content-range') ?? '';
    const match = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    const actualStart = match ? Number.parseInt(match[1], 10) : Number.NaN;
    const actualEnd = match ? Number.parseInt(match[2], 10) : Number.NaN;
    const totalSize = match ? Number.parseInt(match[3], 10) : Number.NaN;
    const bytes = await response.arrayBuffer();
    if (
      !Number.isFinite(totalSize) ||
      totalSize <= 0 ||
      actualStart !== start ||
      !Number.isFinite(actualEnd) ||
      actualEnd < actualStart ||
      actualEnd > end ||
      actualEnd >= totalSize ||
      bytes.byteLength !== actualEnd - actualStart + 1 ||
      bytes.byteLength === 0
    ) {
      throw new DownloadHttpError(url, 206);
    }
    return {
      bytes,
      totalSize,
      contentType: response.headers.get('content-type') ?? 'audio/webm',
    };
  }

  if (response.status === 200) {
    // The server ignored the Range header. Only acceptable for the very first
    // request; otherwise we would append the whole file after partial data.
    if (start !== 0) {
      throw new DownloadHttpError(url, 200);
    }
    const bytes = await response.arrayBuffer();
    return {
      bytes,
      totalSize: bytes.byteLength,
      contentType: response.headers.get('content-type') ?? 'audio/webm',
    };
  }

  throw new DownloadHttpError(url, response.status);
}

/** Number of leading chunks that are present, i.e. the resumable prefix. */
async function countContiguousChunks(
  cache: Cache,
  cacheKey: string,
  meta: AudioCacheMeta,
): Promise<number> {
  for (let index = 0; index < meta.chunkSizes.length; index += 1) {
    if (!(await cache.match(getAudioChunkKey(cacheKey, index)))) return index;
  }
  return meta.chunkSizes.length;
}

export interface AudioDownloadProgress {
  bytesLoaded: number;
  totalBytes: number;
}

/**
 * Download `url` into `cache` as chunks, resuming from any complete chunks
 * already stored. Resolves with the total size in bytes.
 */
export async function downloadAudioChunks(options: {
  cache: Cache;
  url: string;
  cacheKey: string;
  signal: AbortSignal;
  onProgress: (progress: AudioDownloadProgress) => void | Promise<void>;
}): Promise<number> {
  const { cache, url, cacheKey, signal, onProgress } = options;

  let meta = await readAudioCacheMeta(cache, cacheKey);
  if (meta) {
    // Resume from the longest contiguous prefix of stored chunks. A missing
    // chunk in the middle does not throw away what precedes it.
    const prefix = await countContiguousChunks(cache, cacheKey, meta);
    if (prefix === 0) {
      meta = null;
    } else {
      // Metadata that verification would reject must not pass the fast path
      // below: normalise the completion flag to the bytes actually recorded
      // and start over when the sizes cannot be trusted.
      const chunkSizes = meta.chunkSizes.slice(0, prefix);
      const candidate: AudioCacheMeta = {
        ...meta,
        chunkCount: prefix,
        chunkSizes,
        complete: audioCacheMetaBytes({ chunkSizes }) === meta.totalSize,
      };
      if (!isConsistentAudioCacheMeta(candidate)) {
        meta = null;
      } else if (
        candidate.chunkCount !== meta.chunkCount ||
        candidate.complete !== meta.complete
      ) {
        meta = candidate;
        await writeAudioCacheMeta(cache, cacheKey, meta);
      } else {
        meta = candidate;
      }
    }
  }
  if (!meta) {
    await deleteAudioCacheEntries(cache, cacheKey);
  }

  let bytesLoaded = meta
    ? meta.chunkSizes.reduce((sum, size) => sum + size, 0)
    : 0;

  if (meta && meta.complete && bytesLoaded >= meta.totalSize) {
    await onProgress({
      bytesLoaded: meta.totalSize,
      totalBytes: meta.totalSize,
    });
    return meta.totalSize;
  }

  if (!meta) {
    const first = await fetchRangeChunk(url, 0, AUDIO_CHUNK_SIZE - 1, signal);
    await cache.put(
      getAudioChunkKey(cacheKey, 0),
      new Response(first.bytes, {
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    bytesLoaded = first.bytes.byteLength;
    meta = {
      totalSize: first.totalSize,
      chunkCount: 1,
      chunkSizes: [first.bytes.byteLength],
      contentType: first.contentType,
      complete: bytesLoaded >= first.totalSize,
    };
    await writeAudioCacheMeta(cache, cacheKey, meta);
    await onProgress({ bytesLoaded, totalBytes: meta.totalSize });
  }

  while (bytesLoaded < meta.totalSize) {
    if (signal.aborted) {
      throw new DOMException('Download aborted', 'AbortError');
    }
    const start = bytesLoaded;
    const end = Math.min(start + AUDIO_CHUNK_SIZE - 1, meta.totalSize - 1);
    const chunk = await fetchRangeChunk(url, start, end, signal);
    if (chunk.totalSize !== meta.totalSize) {
      // The file changed on the server; start over on the next attempt.
      await deleteAudioCacheEntries(cache, cacheKey);
      throw new DownloadHttpError(url, 409);
    }

    const chunkIndex: number = meta.chunkSizes.length;
    await cache.put(
      getAudioChunkKey(cacheKey, chunkIndex),
      new Response(chunk.bytes, {
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    bytesLoaded += chunk.bytes.byteLength;
    meta = {
      ...meta,
      chunkCount: chunkIndex + 1,
      chunkSizes: [...meta.chunkSizes, chunk.bytes.byteLength],
      complete: bytesLoaded >= meta.totalSize,
    };
    await writeAudioCacheMeta(cache, cacheKey, meta);
    await onProgress({ bytesLoaded, totalBytes: meta.totalSize });
  }

  return meta.totalSize;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

function snapshotEvent(event: EventDetailResponse): DownloadEventSnapshot {
  return {
    id: event.id,
    title: event.title,
    locationName: event.location?.name ?? null,
    dateYear: event.dateYear,
    dateMonth: event.dateMonth,
    dateDay: event.dateDay,
    sessionIndex: event.sessionIndex,
    sessionOrdinal: event.sessionOrdinal,
    sessionCount: event.sessionCount,
    publishedArtwork: event.publishedArtwork
      ? {
          id: event.publishedArtwork.id,
          publishedAt: event.publishedArtwork.publishedAt,
        }
      : null,
  };
}

function snapshotEventRecording(
  recording: EventRecording,
  event: EventDetailResponse,
): DownloadRecordingSnapshot {
  return {
    title: recording.title,
    artist: recording.artist,
    durationHms: recording.durationHms,
    recorderName: recording.recorder?.name ?? null,
    dateYear: event.dateYear,
    dateMonth: event.dateMonth,
    dateDay: event.dateDay,
  };
}

function snapshotEntryRecording(
  entry: CatalogEntryResponse,
): DownloadRecordingSnapshot {
  return {
    title: entry.curatedTitle ?? entry.title ?? null,
    artist: entry.curatedArtist ?? entry.artist ?? null,
    durationHms: entry.duration ?? null,
    recorderName: entry.recorder?.name ?? null,
    dateYear: entry.dateYear ?? null,
    dateMonth: entry.dateMonth ?? null,
    dateDay: entry.dateDay ?? null,
  };
}

/** The event id encoded in a record's event key, when it belongs to `catalogId`. */
function eventIdFromKey(
  eventKey: string | null,
  catalogId: string,
): number | null {
  if (!eventKey || !eventKey.startsWith(`${catalogId}:`)) return null;
  const eventId = Number(eventKey.slice(catalogId.length + 1));
  return Number.isSafeInteger(eventId) && eventId >= 0 ? eventId : null;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface StorageEstimateSnapshot {
  usage: number;
  quota: number;
}

export interface DownloadManagerSnapshot {
  /** False when Cache Storage or IndexedDB is missing (e.g. private mode). */
  supported: boolean;
  hydrated: boolean;
  /** Records visible to the current user, newest first. */
  records: DownloadRecord[];
  activeKey: string | null;
  storage: StorageEstimateSnapshot | null;
}

export interface EnqueueRecordingInput {
  catalogId: string;
  catalogLabel?: string | null;
  hash: string;
  event?: DownloadEventSnapshot | null;
  recording?: DownloadRecordingSnapshot | null;
}

export interface EnqueueEventInput {
  catalogId: string;
  catalogLabel?: string | null;
  eventId: number;
  /** Preferred recording; defaults to the event's primary recording. */
  hash?: string | null;
}

export function isDownloadSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'caches' in window &&
    isIndexedDBAvailable() &&
    typeof fetch === 'function' &&
    'serviceWorker' in navigator
  );
}

const SERVER_SNAPSHOT: DownloadManagerSnapshot = {
  supported: false,
  hydrated: false,
  records: [],
  activeKey: null,
  storage: null,
};

type Listener = () => void;
type DownloadChannelMessage =
  { type: 'changed' } | { type: 'abort'; key: string };

class DownloadManager {
  private listeners = new Set<Listener>();
  private records = new Map<string, DownloadRecord>();
  private controllers = new Map<string, AbortController>();
  private jobs = new Map<string, Promise<void>>();
  private snapshot: DownloadManagerSnapshot = SERVER_SNAPSHOT;
  private hydratePromise: Promise<void> | null = null;
  private processing = false;
  private online = true;
  private onlineGeneration = 0;
  private userId: string | null = null;
  private activeKey: string | null = null;
  private storage: StorageEstimateSnapshot | null = null;
  private channel: BroadcastChannel | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptPermissionReconciliation: Promise<void> | null = null;
  private transcriptPermissionReconciliationPending = false;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): DownloadManagerSnapshot => this.snapshot;

  getServerSnapshot = (): DownloadManagerSnapshot => SERVER_SNAPSHOT;

  /** Load the registry once. Safe to call repeatedly. */
  hydrate(): Promise<void> {
    if (!this.hydratePromise) {
      this.hydratePromise = this.doHydrate().catch((error) => {
        logger.error('Failed to load downloads', { error });
        this.hydratePromise = null;
        this.publish({ hydrated: true });
      });
    }
    return this.hydratePromise;
  }

  private async doHydrate(): Promise<void> {
    if (!isDownloadSupported()) {
      this.publish({ supported: false, hydrated: true });
      return;
    }
    this.online =
      typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    this.openChannel();

    const stored = await listDownloads();
    this.records.clear();
    const recovered: DownloadRecord[] = [];
    for (const record of stored) {
      // A download that was in flight when the page closed is simply queued again.
      const normalized =
        record.catalogLabel === undefined
          ? { ...record, catalogLabel: null }
          : record;
      const next =
        normalized.status === 'downloading'
          ? {
              ...normalized,
              status: 'queued' as const,
            }
          : normalized;
      this.records.set(record.key, next);
      if (next !== record) recovered.push(next);
    }
    await Promise.all(recovered.map((record) => putDownload(record)));
    // One cache handle for hydration. When it cannot be opened, verification
    // marks every completed package retryable and inline preparation is
    // skipped; hydration still finishes so the queue and Retry keep working.
    let audioCache: Cache | null = null;
    try {
      audioCache = await caches.open(OFFLINE_CACHE_NAMES.audio);
    } catch (error) {
      logger.warn('Could not open the audio cache during hydration', { error });
    }
    const needsInlineAudio =
      typeof navigator !== 'undefined' &&
      requiresInlineOfflineAudio(navigator.userAgent);
    // Prepare missing inline copies before verification, which requires them
    // on these browsers; a package that cannot get one then becomes retryable.
    if (audioCache !== null && this.online && needsInlineAudio) {
      for (const record of this.records.values()) {
        if (record.status !== 'complete' || !record.audioCacheKey) continue;
        try {
          const bundle = await getDownloadBundle(record.key);
          if (!bundle || bundle.inlineAudio?.data) continue;
          const blob = await readCompleteAudioBlob(
            audioCache,
            record.audioCacheKey,
          );
          if (!blob) continue;
          await putDownloadBundle({
            ...bundle,
            inlineAudio: {
              data: await blob.arrayBuffer(),
              contentType: blob.type || 'audio/webm',
            },
            updatedAt: Date.now(),
          });
        } catch (error) {
          logger.warn('Failed to prepare existing WebKit offline audio', {
            key: record.key,
            error,
          });
        }
      }
    }
    await this.verifyCompletePackages(audioCache, needsInlineAudio);
    this.publish({ supported: true, hydrated: true });
    void this.refreshStorageEstimate();
    if (
      this.online &&
      Array.from(this.records.values()).some(
        (record) => record.status === 'complete',
      )
    ) {
      void warmDownloadsShell();
    }
    this.scheduleTranscriptPermissionReconciliation();
    void this.processQueue();
  }

  setUserId(userId: string | null): void {
    if (this.userId === userId) return;
    this.userId = userId;
    this.publish();
    this.scheduleTranscriptPermissionReconciliation();
  }

  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (online) {
      this.onlineGeneration += 1;
      void this.resumeInterruptedDownloads();
      this.scheduleTranscriptPermissionReconciliation();
    }
  }

  getRecord(catalogId: string, hash: string): DownloadRecord | undefined {
    return this.records.get(makeDownloadKey(catalogId, hash));
  }

  findEventRecord(
    catalogId: string,
    eventId: number,
  ): DownloadRecord | undefined {
    const eventKey = makeEventKey(catalogId, eventId);
    return Array.from(this.records.values()).find(
      (record) => record.eventKey === eventKey,
    );
  }

  async enqueueRecording(
    input: EnqueueRecordingInput,
  ): Promise<DownloadRecord> {
    await ensureOfflinePlaybackWorker();
    await this.hydrate();
    const key = makeDownloadKey(input.catalogId, input.hash);
    const existing = this.records.get(key);
    if (existing) {
      const eventKey = input.event
        ? makeEventKey(input.catalogId, input.event.id)
        : existing.eventKey;
      const addsEvent = existing.event === null && input.event != null;
      const enriched: DownloadRecord = {
        ...existing,
        catalogLabel: existing.catalogLabel ?? input.catalogLabel ?? null,
        eventKey,
        event: existing.event ?? input.event ?? null,
        recording: existing.recording ?? input.recording ?? null,
        ...(addsEvent && existing.status === 'complete'
          ? {
              status: 'queued' as const,
              progress: 99,
              completedAt: null,
            }
          : {}),
      };
      if (
        enriched.catalogLabel !== existing.catalogLabel ||
        enriched.eventKey !== existing.eventKey ||
        enriched.event !== existing.event ||
        enriched.recording !== existing.recording ||
        enriched.status !== existing.status
      ) {
        await this.write(enriched);
      }
      if (addsEvent && existing.status === 'complete') {
        void this.processQueue();
        return enriched;
      }
      if (existing.status === 'paused' || existing.status === 'error') {
        await this.resume(key);
      }
      return this.records.get(key) ?? existing;
    }

    await this.requestPersistentStorage();
    const now = Date.now();
    const record: DownloadRecord = {
      key,
      catalogId: input.catalogId,
      catalogLabel: input.catalogLabel ?? null,
      hash: input.hash,
      userId: this.userId,
      eventKey: input.event
        ? makeEventKey(input.catalogId, input.event.id)
        : null,
      event: input.event ?? null,
      recording: input.recording ?? null,
      audioUrl: null,
      audioCacheKey: null,
      status: 'queued',
      progress: 0,
      bytesLoaded: 0,
      totalBytes: 0,
      error: null,
      resumeOnReconnect: false,
      transcriptBackend: null,
      hasArtwork: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await this.write(record);
    void this.processQueue();
    return record;
  }

  async enqueueEvent(input: EnqueueEventInput): Promise<DownloadRecord> {
    await this.hydrate();
    const existing = this.findEventRecord(input.catalogId, input.eventId);
    if (existing) {
      if (existing.status === 'paused' || existing.status === 'error') {
        await this.resume(existing.key);
      }
      return this.records.get(existing.key) ?? existing;
    }

    const controller = new AbortController();
    const event = await fetchJson<EventDetailResponse>(
      buildEventDetailUrl(input.catalogId, input.eventId),
      controller.signal,
    );
    const recording =
      (input.hash
        ? event.recordings.find((item) => item.audioHash === input.hash)
        : undefined) ??
      event.recordings.find((item) => item.isPrimary) ??
      event.recordings[0];
    if (!recording) {
      throw new Error('Event has no recordings to download');
    }

    return this.enqueueRecording({
      catalogId: input.catalogId,
      catalogLabel: input.catalogLabel,
      hash: recording.audioHash,
      event: snapshotEvent(event),
      recording: snapshotEventRecording(recording, event),
    });
  }

  async pause(key: string): Promise<void> {
    const record = this.records.get(key);
    if (!record || record.status === 'complete') return;
    await this.write({
      ...record,
      status: 'paused',
      resumeOnReconnect: false,
    });
    this.controllers.get(key)?.abort();
    this.broadcast({ type: 'abort', key });
  }

  async resume(key: string): Promise<void> {
    const record = this.records.get(key);
    if (
      !record ||
      record.status === 'complete' ||
      record.status === 'downloading'
    )
      return;
    await this.write({
      ...record,
      status: 'queued',
      error: null,
      resumeOnReconnect: false,
    });
    void this.processQueue();
  }

  async remove(key: string): Promise<void> {
    const record = this.records.get(key);
    if (!record) return;

    if (record.status !== 'complete') {
      await this.write({
        ...record,
        status: 'paused',
        resumeOnReconnect: false,
      });
      this.controllers.get(key)?.abort();
      this.broadcast({ type: 'abort', key });
      await this.jobs.get(key)?.catch(() => undefined);
    }

    // The tab running this key holds the same lock. Waiting here guarantees
    // that its fetch has unwound before bytes and registry state are removed.
    await this.withDownloadLock(key, async () => {
      this.records.delete(key);
      this.publish();
      await deleteDownloadRecord(key).catch((error) => {
        logger.warn('Failed to delete download record', { key, error });
      });
      await this.deleteBundle(record);
    });
    this.broadcast();
    void this.refreshStorageEstimate();
  }

  async removeAll(): Promise<void> {
    const keys = Array.from(this.records.keys());
    for (const key of keys) {
      await this.remove(key);
    }
  }

  async refreshStorageEstimate(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate)
      return;
    try {
      const estimate = await navigator.storage.estimate();
      this.storage = {
        usage: estimate.usage ?? 0,
        quota: estimate.quota ?? 0,
      };
      this.publish();
    } catch {
      // Estimates are advisory only.
    }
  }

  // -- internals -----------------------------------------------------------

  private async requestPersistentStorage(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    try {
      if (window.localStorage.getItem(PERSIST_REQUESTED_KEY) === '1') return;
      window.localStorage.setItem(PERSIST_REQUESTED_KEY, '1');
      await navigator.storage.persist();
    } catch {
      // Best effort; the browser may refuse or storage may be unavailable.
    }
  }

  /**
   * Registry state alone does not prove playability. A record marked complete
   * whose audio is missing or incomplete in Cache Storage becomes a retryable
   * error instead of a download that fails when played; Retry resumes from
   * the chunks that exist. Browsers that play offline audio only from the
   * inline copy also need that copy in the bundle; Retry rebuilds it.
   */
  private async verifyCompletePackages(
    audioCache: Cache | null,
    needsInlineAudio: boolean,
  ): Promise<void> {
    // Fail closed: with no readable cache every completed package below
    // becomes retryable, because bytes that cannot be read cannot be offered.
    for (const key of Array.from(this.records.keys())) {
      if (this.records.get(key)?.status !== 'complete') continue;
      // Another tab may remove or change this download while hydration runs.
      // Verify and write under its lock against the persisted row, so a
      // download removed elsewhere is never recreated here as an error.
      await this.withDownloadLock(key, async () => {
        const persisted = await getDownload(key);
        if (!persisted) {
          this.records.delete(key);
          return;
        }
        if (persisted.status !== 'complete') {
          this.records.set(key, persisted);
          return;
        }
        let verified = false;
        try {
          verified =
            audioCache !== null &&
            persisted.audioCacheKey !== null &&
            (await verifyAudioCache(audioCache, persisted.audioCacheKey));
          if (verified && needsInlineAudio) {
            const bundle = await getDownloadBundle(key);
            verified = !!bundle?.inlineAudio?.data;
          }
        } catch (error) {
          // Unverifiable is not verified.
          logger.warn('Could not verify a downloaded package', { key, error });
        }
        if (verified) return;
        logger.warn(
          'Downloaded audio is missing or incomplete; marking for retry',
          { key },
        );
        await this.write({
          ...persisted,
          status: 'error',
          error: INCOMPLETE_PACKAGE_ERROR,
          progress: 0,
          resumeOnReconnect: false,
          completedAt: null,
        });
      });
    }
  }

  private scheduleTranscriptPermissionReconciliation(): void {
    if (!this.online || !this.userId || !this.snapshot.hydrated) {
      return;
    }
    if (this.transcriptPermissionReconciliation) {
      this.transcriptPermissionReconciliationPending = true;
      return;
    }

    const userId = this.userId;
    this.transcriptPermissionReconciliation =
      this.reconcileTranscriptPermissions(userId).finally(() => {
        this.transcriptPermissionReconciliation = null;
        if (this.transcriptPermissionReconciliationPending) {
          this.transcriptPermissionReconciliationPending = false;
          this.scheduleTranscriptPermissionReconciliation();
        }
      });
  }

  /**
   * Re-check completed packages against the server while online: drop a
   * transcript the account may no longer retain, keep the stored entry's
   * permissions current (the local reader derives the speaker overlay from
   * them), and store the event detail and entry payloads on packages written
   * before they were part of the bundle, so the shared pages can render them
   * offline.
   */
  private async reconcileTranscriptPermissions(userId: string): Promise<void> {
    const signal = new AbortController().signal;
    const candidates = Array.from(this.records.values()).filter(
      (record) =>
        record.status === 'complete' &&
        (record.userId === null || record.userId === userId),
    );

    for (const record of candidates) {
      if (!this.online || this.userId !== userId) return;

      let bundle: DownloadBundlePayload | undefined;
      try {
        bundle = await getDownloadBundle(record.key);
      } catch {
        bundle = undefined;
      }
      const missingEntry = !bundle?.entry;
      const missingEventDetail =
        record.eventKey !== null && !bundle?.eventDetail;
      const needsPackageRefresh = missingEntry || missingEventDetail;
      if (record.transcriptBackend === null && !needsPackageRefresh) continue;

      let entry: CatalogEntryWithPermissions | null = null;
      try {
        entry = await fetchJson<CatalogEntryWithPermissions>(
          buildRecordingEntryUrl(record.catalogId, record.hash),
          signal,
        );
      } catch (error) {
        if (isNetworkError(error)) return;
        const permissionDenied =
          error instanceof DownloadHttpError &&
          (error.status === 403 || error.status === 404);
        if (!permissionDenied) {
          logger.debug('Could not refresh an offline package', {
            key: record.key,
            error,
          });
          continue;
        }
      }

      if (!this.online || this.userId !== userId) return;
      const transcriptPermitted =
        entry?.canViewTranscripts === true &&
        entry.canDownloadTranscripts === true;
      if (record.transcriptBackend !== null && !transcriptPermitted) {
        try {
          await this.removeStoredTranscript(record);
        } catch (error) {
          logger.warn('Failed to remove an offline transcript', {
            key: record.key,
            error,
          });
        }
      }

      const speakersPermitted = entry?.canSeeSpeakers === true;
      const entitlementChanged =
        entry !== null &&
        (bundle?.entry?.canSeeSpeakers === true) !== speakersPermitted;
      const dropDiarization =
        entry !== null && !speakersPermitted && !!bundle?.diarization;
      if (entry && (needsPackageRefresh || entitlementChanged || dropDiarization)) {
        let eventDetail = bundle?.eventDetail ?? null;
        const eventId = eventIdFromKey(record.eventKey, record.catalogId);
        if (missingEventDetail && eventId !== null) {
          try {
            eventDetail = await tryFetchJson<EventDetailResponse>(
              buildEventDetailUrl(record.catalogId, eventId),
              signal,
            );
          } catch (error) {
            if (isNetworkError(error)) return;
            eventDetail = null;
          }
        }
        if (!this.online || this.userId !== userId) return;
        try {
          const current = (await getDownloadBundle(record.key)) ?? {
            key: record.key,
            transcriptBackend: null,
            transcript: null,
            diarization: null,
            artwork: null,
            updatedAt: 0,
          };
          await putDownloadBundle({
            ...current,
            entry,
            eventDetail: eventDetail ?? current.eventDetail ?? null,
            // The overlay is administrative; a revoked permission removes it.
            diarization: speakersPermitted ? current.diarization : null,
            updatedAt: Date.now(),
          });
        } catch (error) {
          logger.warn('Failed to refresh an offline package', {
            key: record.key,
            error,
          });
        }
      }
    }
  }

  private async removeStoredTranscript(record: DownloadRecord): Promise<void> {
    const bundle = await getDownloadBundle(record.key);
    if (bundle) {
      await putDownloadBundle({
        ...bundle,
        transcriptBackend: null,
        transcript: null,
        diarization: null,
        updatedAt: Date.now(),
      });
    }
    await this.update(record.key, { transcriptBackend: null });
  }

  private openChannel(): void {
    if (this.channel || typeof BroadcastChannel === 'undefined') return;
    try {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.addEventListener(
        'message',
        (event: MessageEvent<unknown>) => {
          const message = event.data as Partial<DownloadChannelMessage> | null;
          if (!message || typeof message !== 'object') return;
          if (message.type === 'abort' && typeof message.key === 'string') {
            this.controllers.get(message.key)?.abort();
          }
          if (message.type === 'changed' || message.type === 'abort') {
            this.scheduleReload();
          }
        },
      );
    } catch {
      this.channel = null;
    }
  }

  private broadcast(
    message: DownloadChannelMessage = { type: 'changed' },
  ): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // Ignore; other tabs will catch up on their next hydrate.
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.reloadFromDatabase();
    }, 200);
  }

  private async reloadFromDatabase(): Promise<void> {
    try {
      const stored = await listDownloads();
      const next = new Map<string, DownloadRecord>();
      for (const record of stored) {
        // Keep our own in-flight record; its progress is ahead of the database.
        if (record.key === this.activeKey) {
          const active = this.records.get(record.key);
          next.set(record.key, active ?? record);
        } else {
          next.set(record.key, record);
        }
      }
      this.records = next;
      this.publish();
      void this.processQueue();
    } catch (error) {
      logger.warn('Failed to reload downloads', { error });
    }
  }

  private async write(record: DownloadRecord): Promise<void> {
    const next = { ...record, updatedAt: Date.now() };
    this.records.set(next.key, next);
    this.publish();
    await putDownload(next);
    this.broadcast();
  }

  private async update(
    key: string,
    patch: Partial<DownloadRecord>,
  ): Promise<DownloadRecord | null> {
    const current = this.records.get(key);
    if (!current) return null;
    const next = { ...current, ...patch };
    await this.write(next);
    return next;
  }

  private publish(
    patch: Partial<
      Pick<DownloadManagerSnapshot, 'supported' | 'hydrated'>
    > = {},
  ): void {
    const visible = Array.from(this.records.values())
      .filter(
        (record) =>
          record.userId === null ||
          this.userId === null ||
          record.userId === this.userId,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    this.snapshot = {
      supported: patch.supported ?? this.snapshot.supported,
      hydrated: patch.hydrated ?? this.snapshot.hydrated,
      records: visible,
      activeKey: this.activeKey,
      storage: this.storage,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private nextQueued(): DownloadRecord | undefined {
    return Array.from(this.records.values())
      .filter((record) => record.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  private async resumeInterruptedDownloads(): Promise<void> {
    const interrupted = Array.from(this.records.values()).filter(
      (record) => record.status === 'paused' && record.resumeOnReconnect,
    );
    for (const record of interrupted) {
      await this.write({
        ...record,
        status: 'queued',
        resumeOnReconnect: false,
      });
    }
    await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.online || !this.snapshot.supported) return;
    if (!this.nextQueued()) return;
    this.processing = true;
    try {
      await this.withQueueLock(async () => {
        for (
          let next = this.nextQueued();
          next && this.online;
          next = this.nextQueued()
        ) {
          await this.withDownloadLock(next.key, async () => {
            const persisted = await getDownload(next.key);
            if (!persisted || persisted.status !== 'queued') {
              await this.reloadFromDatabase();
              return;
            }
            this.records.set(next.key, persisted);
            const job = this.runJob(next.key);
            this.jobs.set(next.key, job);
            try {
              await job;
            } finally {
              this.jobs.delete(next.key);
            }
          });
        }
      });
    } finally {
      this.processing = false;
    }
  }

  private async withQueueLock(work: () => Promise<void>): Promise<void> {
    const locks =
      typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks) {
      await work();
      return;
    }
    await locks.request(
      QUEUE_LOCK_NAME,
      { ifAvailable: true },
      async (lock) => {
        // Another tab owns the queue; it will pick up our records via the channel.
        if (!lock) return;
        await work();
      },
    );
  }

  private async withDownloadLock(
    key: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const locks =
      typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks) {
      await work();
      return;
    }
    await locks.request(`${DOWNLOAD_LOCK_PREFIX}${key}`, async () => {
      await work();
    });
  }

  private async runJob(key: string): Promise<void> {
    const startedOnlineGeneration = this.onlineGeneration;
    const controller = new AbortController();
    const { signal } = controller;
    this.controllers.set(key, controller);
    this.activeKey = key;

    try {
      await ensureOfflinePlaybackWorker();
      const started = await this.update(key, {
        status: 'downloading',
        error: null,
        resumeOnReconnect: false,
      });
      if (!started) return;

      const audioCache = await caches.open(OFFLINE_CACHE_NAMES.audio);
      const { catalogId, hash } = started;

      const entry = await fetchJson<CatalogEntryWithPermissions>(
        buildRecordingEntryUrl(catalogId, hash),
        signal,
      );
      // The event page renders from this payload when the network is gone.
      const eventId = eventIdFromKey(started.eventKey, catalogId);
      const eventDetail =
        eventId === null
          ? null
          : await tryFetchJson<EventDetailResponse>(
              buildEventDetailUrl(catalogId, eventId),
              signal,
            );
      const sources = await tryFetchJson<SourcesResponse>(
        buildAudioSourcesUrl(catalogId, hash),
        signal,
      );
      const preference = await tryFetchJson<PreferenceResponse>(
        buildAudioSourcePreferenceUrl(catalogId, hash),
        signal,
      );

      const availableSources = sources?.sources ?? [];
      const preferredSource =
        preference?.sourceId &&
        availableSources.some((source) => source.id === preference.sourceId)
          ? preference.sourceId
          : null;
      const audioSource =
        preferredSource ?? sources?.defaultSource ?? 'archived';
      const audioUrl = buildAudioUrl(
        catalogId,
        hash,
        audioSource,
        availableSources,
      );
      const audioCacheKey = getAudioCacheKey(audioUrl, window.location.origin);

      if (started.audioCacheKey && started.audioCacheKey !== audioCacheKey) {
        await deleteAudioCacheEntries(audioCache, started.audioCacheKey);
      }

      await this.update(key, {
        audioUrl,
        audioCacheKey,
        recording: started.recording ?? snapshotEntryRecording(entry.entry),
      });

      await downloadAudioChunks({
        cache: audioCache,
        url: audioUrl,
        cacheKey: audioCacheKey,
        signal,
        onProgress: async ({ bytesLoaded, totalBytes }) => {
          const ratio = totalBytes > 0 ? bytesLoaded / totalBytes : 0;
          await this.update(key, {
            bytesLoaded,
            totalBytes,
            progress: Math.min(99, Math.floor(ratio * 100)),
          });
        },
      });
      const needsInlineAudio =
        typeof navigator !== 'undefined' &&
        requiresInlineOfflineAudio(navigator.userAgent);
      const offlineAudioBlob = needsInlineAudio
        ? await readCompleteAudioBlob(audioCache, audioCacheKey)
        : null;
      if (needsInlineAudio && !offlineAudioBlob) {
        throw new Error('Downloaded audio cache is incomplete');
      }

      let transcriptBackend: string | null = null;
      let transcript: Transcript | null = null;
      let diarization: Diarization | null = null;
      if (entry.canViewTranscripts && entry.canDownloadTranscripts) {
        const transcriptPayload = await this.downloadTranscriptBundle(
          catalogId,
          hash,
          // The speaker overlay is administrative; store it only for an
          // account that may see it, so the offline page cannot show more.
          entry.canSeeSpeakers === true,
          signal,
        );
        transcriptBackend = transcriptPayload.transcriptBackend;
        transcript = transcriptPayload.transcript;
        diarization = transcriptPayload.diarization;
      }

      let artwork: DownloadArtworkPayload | null = null;
      const currentEvent = this.records.get(key)?.event ?? started.event;
      if (currentEvent) {
        artwork = await this.downloadEventArtwork(
          catalogId,
          currentEvent,
          signal,
        );
      }

      await putDownloadBundle({
        key,
        transcriptBackend,
        transcript,
        diarization,
        artwork,
        eventDetail,
        entry,
        inlineAudio: offlineAudioBlob
          ? {
              data: await offlineAudioBlob.arrayBuffer(),
              contentType: offlineAudioBlob.type || 'audio/webm',
            }
          : null,
        updatedAt: Date.now(),
      });

      await this.update(key, {
        status: 'complete',
        progress: 100,
        error: null,
        resumeOnReconnect: false,
        transcriptBackend,
        hasArtwork: artwork !== null,
        completedAt: Date.now(),
      });
      void warmDownloadsShell();
    } catch (error) {
      if (signal.aborted) {
        // pause() or remove() already recorded the new state.
        return;
      }
      if (isNetworkError(error)) {
        logger.info('Download paused by network loss', { key });
        await this.update(key, {
          status: 'paused',
          error: null,
          resumeOnReconnect: true,
        });
        // A short outage can report "online" before the failed fetch rejects.
        // Requeue only when an actual offline -> online transition happened
        // during this job; retrying every TypeError while still online would
        // otherwise create a tight failure loop.
        if (this.online && this.onlineGeneration > startedOnlineGeneration) {
          await this.update(key, {
            status: 'queued',
            resumeOnReconnect: false,
          });
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Download failed', { key, error });
        await this.update(key, { status: 'error', error: message });
      }
    } finally {
      this.controllers.delete(key);
      if (this.activeKey === key) {
        this.activeKey = null;
      }
      this.publish();
      void this.refreshStorageEstimate();
    }
  }

  private async downloadTranscriptBundle(
    catalogId: string,
    hash: string,
    includeDiarization: boolean,
    signal: AbortSignal,
  ): Promise<
    Pick<
      DownloadBundlePayload,
      'transcriptBackend' | 'transcript' | 'diarization'
    >
  > {
    const [backends, diarizations] = await Promise.all([
      tryFetchJson<TranscriptBackendsResponse>(
        buildTranscriptBackendsUrl(hash, catalogId),
        signal,
      ),
      includeDiarization
        ? tryFetchJson<DiarizationBackendsResponse>(
            buildDiarizationBackendsUrl(hash, catalogId),
            signal,
          )
        : Promise.resolve(null),
    ]);
    const backend = backends?.backends[0];
    if (!backend) {
      return { transcriptBackend: null, transcript: null, diarization: null };
    }

    const diarizationBackend = diarizations?.backends.includes('pyannote')
      ? 'pyannote'
      : diarizations?.backends[0];
    const [transcript, diarization] = await Promise.all([
      tryFetchJson<Transcript>(
        buildTranscriptUrl(hash, catalogId, backend),
        signal,
      ),
      diarizationBackend
        ? tryFetchJson<Diarization>(
            buildDiarizationUrl(hash, catalogId, diarizationBackend),
            signal,
          )
        : Promise.resolve(null),
    ]);
    return {
      transcriptBackend: transcript ? backend : null,
      transcript,
      diarization,
    };
  }

  private async downloadEventArtwork(
    catalogId: string,
    event: DownloadEventSnapshot,
    signal: AbortSignal,
  ): Promise<DownloadArtworkPayload | null> {
    const artwork = event.publishedArtwork;
    if (!artwork) return null;
    const preferred = window.matchMedia(EVENT_ARTWORK_LANDSCAPE_MEDIA).matches
      ? 'landscape'
      : 'square';
    const fallback = preferred === 'landscape' ? 'square' : 'landscape';
    const preferredArtwork = await tryFetchArtwork(
      buildEventArtworkUrl(catalogId, event.id, preferred, artwork.id),
      preferred,
      artwork.id,
      signal,
    );
    if (preferredArtwork) return preferredArtwork;
    return tryFetchArtwork(
      buildEventArtworkUrl(catalogId, event.id, fallback, artwork.id),
      fallback,
      artwork.id,
      signal,
    );
  }

  private async deleteBundle(record: DownloadRecord): Promise<void> {
    const removals: Promise<unknown>[] = [deleteDownloadBundle(record.key)];
    const { audioCacheKey } = record;
    if (audioCacheKey) {
      removals.push(
        caches
          .open(OFFLINE_CACHE_NAMES.audio)
          .then((cache) => deleteAudioCacheEntries(cache, audioCacheKey)),
      );
    }
    const results = await Promise.allSettled(removals);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn('Failed to delete download data', {
          key: record.key,
          error: result.reason,
        });
      }
    }
  }
}

export const downloadManager = new DownloadManager();

export type { DownloadRecord, DownloadStatus } from './downloads-db';
