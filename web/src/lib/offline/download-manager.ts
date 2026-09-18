"use client";

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
import { createClientLogger } from "@/lib/log/client";
import {
  buildAudioSourcePreferenceUrl,
  buildAudioSourcesUrl,
  buildAudioUrl,
  buildDiarizationBackendsUrl,
  buildDiarizationUrl,
  buildEventDetailUrl,
  buildEventPagePath,
  buildEventPosterUrl,
  buildPlaybackProgressUrl,
  buildRecordingEntryUrl,
  buildRecordingPagePath,
  buildTranscriptBackendsUrl,
  buildTranscriptFormatsUrl,
  buildTranscriptUrl,
  type AudioSourceOption,
} from "@/lib/api/recording-urls";
import {
  AUDIO_CHUNK_SIZE,
  deleteAudioCacheEntries,
  getAudioCacheKey,
  getAudioChunkKey,
  readAudioCacheMeta,
  writeAudioCacheMeta,
  type AudioCacheMeta,
} from "./audio-cache-format";
import { CACHED_AT_HEADER, DOWNLOADS_PATH, OFFLINE_CACHE_NAMES } from "./cache-names";
import {
  deleteDownloadRecord,
  isIndexedDBAvailable,
  listDownloads,
  makeDownloadKey,
  makeEventKey,
  putDownload,
  type DownloadEventSnapshot,
  type DownloadRecord,
  type DownloadRecordingSnapshot,
} from "./downloads-db";

const logger = createClientLogger("downloads");
const QUEUE_LOCK_NAME = "besedy-downloads-queue";
const CHANNEL_NAME = "besedy-downloads";
const PERSIST_REQUESTED_KEY = "besedy-storage-persist-requested";
const STATIC_FETCH_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Server response shapes (only the fields the manager reads)
// ---------------------------------------------------------------------------

interface EntryResponse {
  entry: {
    hash: string;
    title?: string | null;
    curatedTitle?: string | null;
    artist?: string | null;
    curatedArtist?: string | null;
    duration?: string | null;
    dateYear?: number | null;
    dateMonth?: number | null;
    dateDay?: number | null;
    recorder?: { id: number; name: string } | null;
  };
  canViewTranscripts: boolean;
}

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

interface EventRecordingResponse {
  audioHash: string;
  isPrimary: boolean;
  sortOrder: number;
  title: string;
  artist: string | null;
  durationHms: string | null;
  recorder: { id: number; name: string } | null;
}

interface EventDetailResponse {
  id: number;
  title: string | null;
  location: { id: number; name: string } | null;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
  sessionIndex: number;
  recordings: EventRecordingResponse[];
  posterFiles?: {
    portrait: { exists: boolean; uploadedAt?: string | null };
    landscape: { exists: boolean; uploadedAt?: string | null };
  } | null;
  posterStatus?: { portrait: boolean; landscape: boolean } | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DownloadHttpError extends Error {
  status: number;
  url: string;

  constructor(url: string, status: number) {
    super(`HTTP ${status} for ${url}`);
    this.name = "DownloadHttpError";
    this.status = status;
    this.url = url;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** A dropped connection, as opposed to a server verdict. */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof DownloadHttpError) return false;
  if (isAbortError(error)) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return error instanceof TypeError;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function cachedAtHeaders(contentType: string): HeadersInit {
  return {
    "content-type": contentType,
    [CACHED_AT_HEADER]: String(Date.now()),
  };
}

async function storeResponse(cache: Cache, url: string, response: Response): Promise<void> {
  // Re-materialize the body so Vary/Set-Cookie headers do not affect matching.
  const body = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  await cache.put(url, new Response(body, { status: 200, headers: cachedAtHeaders(contentType) }));
}

async function fetchAndStore(cache: Cache, url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { credentials: "include", cache: "no-store", signal });
  if (!response.ok) {
    throw new DownloadHttpError(url, response.status);
  }
  await storeResponse(cache, url, response.clone());
  return response;
}

async function fetchJsonAndStore<T>(cache: Cache, url: string, signal: AbortSignal): Promise<T> {
  const response = await fetchAndStore(cache, url, signal);
  return (await response.json()) as T;
}

/** Like fetchJsonAndStore but treats server errors as "not available". */
async function tryFetchJsonAndStore<T>(
  cache: Cache,
  url: string,
  signal: AbortSignal
): Promise<T | null> {
  try {
    return await fetchJsonAndStore<T>(cache, url, signal);
  } catch (error) {
    if (isAbortError(error) || isNetworkError(error)) throw error;
    logger.debug("Optional resource unavailable", { url, error });
    return null;
  }
}

async function tryFetchAndStore(cache: Cache, url: string, signal: AbortSignal): Promise<boolean> {
  try {
    await fetchAndStore(cache, url, signal);
    return true;
  } catch (error) {
    if (isAbortError(error) || isNetworkError(error)) throw error;
    logger.debug("Optional resource unavailable", { url, error });
    return false;
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
  signal: AbortSignal
): Promise<RangeChunk> {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    headers: { Range: `bytes=${start}-${end}` },
    signal,
  });

  if (response.status === 206) {
    const contentRange = response.headers.get("content-range") ?? "";
    const match = contentRange.match(/\/(\d+)$/);
    const totalSize = match ? Number.parseInt(match[1], 10) : Number.NaN;
    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      throw new DownloadHttpError(url, 206);
    }
    return {
      bytes: await response.arrayBuffer(),
      totalSize,
      contentType: response.headers.get("content-type") ?? "audio/webm",
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
      contentType: response.headers.get("content-type") ?? "audio/webm",
    };
  }

  throw new DownloadHttpError(url, response.status);
}

async function hasAllChunks(cache: Cache, cacheKey: string, meta: AudioCacheMeta): Promise<boolean> {
  for (let index = 0; index < meta.chunkSizes.length; index += 1) {
    const chunk = await cache.match(getAudioChunkKey(cacheKey, index));
    if (!chunk) return false;
  }
  return true;
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
  if (meta && (meta.chunkSizes.length === 0 || !(await hasAllChunks(cache, cacheKey, meta)))) {
    meta = null;
  }
  if (!meta) {
    await deleteAudioCacheEntries(cache, cacheKey);
  }

  let bytesLoaded = meta ? meta.chunkSizes.reduce((sum, size) => sum + size, 0) : 0;

  if (meta && meta.complete && bytesLoaded >= meta.totalSize) {
    await onProgress({ bytesLoaded: meta.totalSize, totalBytes: meta.totalSize });
    return meta.totalSize;
  }

  if (!meta) {
    const first = await fetchRangeChunk(url, 0, AUDIO_CHUNK_SIZE - 1, signal);
    await cache.put(
      getAudioChunkKey(cacheKey, 0),
      new Response(first.bytes, { headers: { "Content-Type": "application/octet-stream" } })
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
      throw new DOMException("Download aborted", "AbortError");
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
      new Response(chunk.bytes, { headers: { "Content-Type": "application/octet-stream" } })
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
// Page shell + static assets
// ---------------------------------------------------------------------------

const STATIC_PREFIXED_PATTERN = /\/_next\/static\/[A-Za-z0-9_./%-]+/g;
const STATIC_BARE_PATTERN = /(?<![A-Za-z0-9_/])static\/(?:chunks|css|media)\/[A-Za-z0-9_./%-]+\.(?:js|css|woff2?|ttf|otf|png|svg|ico)/g;
const CSS_URL_PATTERN = /url\((["']?)(\/_next\/static\/[^)"']+)\1\)/g;

/** Collect every build asset URL referenced by an HTML document. */
export function collectStaticAssetUrls(html: string): string[] {
  const unescaped = html.replace(/\\\//g, "/");
  const urls = new Set<string>();
  for (const match of unescaped.match(STATIC_PREFIXED_PATTERN) ?? []) {
    urls.add(match);
  }
  for (const match of unescaped.match(STATIC_BARE_PATTERN) ?? []) {
    urls.add(`/_next/${match}`);
  }
  return Array.from(urls);
}

export function collectCssAssetUrls(css: string): string[] {
  const urls = new Set<string>();
  for (const match of css.matchAll(CSS_URL_PATTERN)) {
    urls.add(match[2]);
  }
  return Array.from(urls);
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function cacheStaticAssets(urls: string[], signal: AbortSignal): Promise<void> {
  if (urls.length === 0) return;
  const cache = await caches.open(OFFLINE_CACHE_NAMES.static);
  const discoveredCss: string[] = [];

  await runWithConcurrency(urls, STATIC_FETCH_CONCURRENCY, async (url) => {
    if (await cache.match(url)) return;
    try {
      const response = await fetch(url, { credentials: "same-origin", signal });
      if (!response.ok) return;
      if (url.endsWith(".css")) {
        const css = await response.clone().text();
        discoveredCss.push(...collectCssAssetUrls(css));
      }
      await cache.put(url, response);
    } catch (error) {
      if (isAbortError(error) || isNetworkError(error)) throw error;
      logger.debug("Static asset skipped", { url, error });
    }
  });

  const remaining = discoveredCss.filter((url) => !urls.includes(url));
  if (remaining.length > 0) {
    await cacheStaticAssets(remaining, signal);
  }
}

/**
 * Store a page's HTML by pathname and prefetch the build assets it references,
 * so the worker can serve the page offline even if it was never visited.
 */
export async function cachePage(pathname: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(pathname, {
    credentials: "include",
    cache: "no-store",
    redirect: "follow",
    headers: { accept: "text/html" },
    signal,
  });
  if (!response.ok || response.redirected) return false;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return false;

  const html = await response.text();
  const shell = await caches.open(OFFLINE_CACHE_NAMES.shell);
  await shell.put(pathname, new Response(html, { headers: cachedAtHeaders(contentType) }));
  await cacheStaticAssets(collectStaticAssetUrls(html), signal);
  return true;
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
  };
}

function snapshotEventRecording(
  recording: EventRecordingResponse,
  event: EventDetailResponse
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

function snapshotEntryRecording(entry: EntryResponse["entry"]): DownloadRecordingSnapshot {
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
  hash: string;
  event?: DownloadEventSnapshot | null;
  recording?: DownloadRecordingSnapshot | null;
}

export interface EnqueueEventInput {
  catalogId: string;
  eventId: number;
  /** Preferred recording; defaults to the event's primary recording. */
  hash?: string | null;
}

export function isDownloadSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "caches" in window &&
    isIndexedDBAvailable() &&
    typeof fetch === "function"
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

class DownloadManager {
  private listeners = new Set<Listener>();
  private records = new Map<string, DownloadRecord>();
  private controllers = new Map<string, AbortController>();
  private jobs = new Map<string, Promise<void>>();
  private snapshot: DownloadManagerSnapshot = SERVER_SNAPSHOT;
  private hydratePromise: Promise<void> | null = null;
  private processing = false;
  private online = true;
  private userId: string | null = null;
  private activeKey: string | null = null;
  private storage: StorageEstimateSnapshot | null = null;
  private channel: BroadcastChannel | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

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
        logger.error("Failed to load downloads", { error });
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
    this.online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
    this.openChannel();

    const stored = await listDownloads();
    this.records.clear();
    for (const record of stored) {
      // A download that was in flight when the page closed is simply queued again.
      this.records.set(
        record.key,
        record.status === "downloading" ? { ...record, status: "queued" } : record
      );
    }
    this.publish({ supported: true, hydrated: true });
    void this.refreshStorageEstimate();
    void this.processQueue();
  }

  setUserId(userId: string | null): void {
    if (this.userId === userId) return;
    this.userId = userId;
    this.publish();
  }

  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (online) {
      void this.processQueue();
    }
  }

  getRecord(catalogId: string, hash: string): DownloadRecord | undefined {
    return this.records.get(makeDownloadKey(catalogId, hash));
  }

  findEventRecord(catalogId: string, eventId: number): DownloadRecord | undefined {
    const eventKey = makeEventKey(catalogId, eventId);
    return Array.from(this.records.values()).find((record) => record.eventKey === eventKey);
  }

  async enqueueRecording(input: EnqueueRecordingInput): Promise<DownloadRecord> {
    await this.hydrate();
    const key = makeDownloadKey(input.catalogId, input.hash);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.status === "paused" || existing.status === "error") {
        await this.resume(key);
      }
      return this.records.get(key) ?? existing;
    }

    await this.requestPersistentStorage();
    const now = Date.now();
    const record: DownloadRecord = {
      key,
      catalogId: input.catalogId,
      hash: input.hash,
      userId: this.userId,
      eventKey: input.event ? makeEventKey(input.catalogId, input.event.id) : null,
      event: input.event ?? null,
      recording: input.recording ?? null,
      audioUrl: null,
      audioCacheKey: null,
      status: "queued",
      progress: 0,
      bytesLoaded: 0,
      totalBytes: 0,
      error: null,
      transcriptBackend: null,
      hasPoster: false,
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
      if (existing.status === "paused" || existing.status === "error") {
        await this.resume(existing.key);
      }
      return this.records.get(existing.key) ?? existing;
    }

    const dataCache = await caches.open(OFFLINE_CACHE_NAMES.data);
    const controller = new AbortController();
    const event = await fetchJsonAndStore<EventDetailResponse>(
      dataCache,
      buildEventDetailUrl(input.catalogId, input.eventId),
      controller.signal
    );
    const recording =
      (input.hash ? event.recordings.find((item) => item.audioHash === input.hash) : undefined) ??
      event.recordings.find((item) => item.isPrimary) ??
      event.recordings[0];
    if (!recording) {
      throw new Error("Event has no recordings to download");
    }

    return this.enqueueRecording({
      catalogId: input.catalogId,
      hash: recording.audioHash,
      event: snapshotEvent(event),
      recording: snapshotEventRecording(recording, event),
    });
  }

  async pause(key: string): Promise<void> {
    const record = this.records.get(key);
    if (!record || record.status === "complete") return;
    await this.write({ ...record, status: "paused" });
    this.controllers.get(key)?.abort();
  }

  async resume(key: string): Promise<void> {
    const record = this.records.get(key);
    if (!record || record.status === "complete" || record.status === "downloading") return;
    await this.write({ ...record, status: "queued", error: null });
    void this.processQueue();
  }

  async remove(key: string): Promise<void> {
    const record = this.records.get(key);
    if (!record) return;

    // Stop the job first and wait for it to unwind so no chunk lands after
    // the cleanup below.
    this.controllers.get(key)?.abort();
    await this.jobs.get(key)?.catch(() => undefined);

    this.records.delete(key);
    this.publish();
    await deleteDownloadRecord(key).catch((error) => {
      logger.warn("Failed to delete download record", { key, error });
    });
    await this.deleteBundle(record);
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
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return;
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

  /** Cache the Downloads page so offline navigations can land there. */
  async warmShell(): Promise<void> {
    if (!isDownloadSupported() || !this.online) return;
    try {
      await cachePage(DOWNLOADS_PATH, new AbortController().signal);
    } catch (error) {
      logger.debug("Shell warm-up skipped", { error });
    }
  }

  // -- internals -----------------------------------------------------------

  private async requestPersistentStorage(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return;
    try {
      if (window.localStorage.getItem(PERSIST_REQUESTED_KEY) === "1") return;
      window.localStorage.setItem(PERSIST_REQUESTED_KEY, "1");
      await navigator.storage.persist();
    } catch {
      // Best effort; the browser may refuse or storage may be unavailable.
    }
  }

  private openChannel(): void {
    if (this.channel || typeof BroadcastChannel === "undefined") return;
    try {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.addEventListener("message", () => this.scheduleReload());
    } catch {
      this.channel = null;
    }
  }

  private broadcast(): void {
    try {
      this.channel?.postMessage({ type: "changed" });
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
      logger.warn("Failed to reload downloads", { error });
    }
  }

  private async write(record: DownloadRecord): Promise<void> {
    const next = { ...record, updatedAt: Date.now() };
    this.records.set(next.key, next);
    this.publish();
    await putDownload(next);
    this.broadcast();
  }

  private async update(key: string, patch: Partial<DownloadRecord>): Promise<DownloadRecord | null> {
    const current = this.records.get(key);
    if (!current) return null;
    const next = { ...current, ...patch };
    await this.write(next);
    return next;
  }

  private publish(patch: Partial<Pick<DownloadManagerSnapshot, "supported" | "hydrated">> = {}): void {
    const visible = Array.from(this.records.values())
      .filter((record) => record.userId === null || this.userId === null || record.userId === this.userId)
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
      .filter((record) => record.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.online || !this.snapshot.supported) return;
    if (!this.nextQueued()) return;
    this.processing = true;
    try {
      await this.withQueueLock(async () => {
        for (let next = this.nextQueued(); next && this.online; next = this.nextQueued()) {
          const job = this.runJob(next.key);
          this.jobs.set(next.key, job);
          try {
            await job;
          } finally {
            this.jobs.delete(next.key);
          }
        }
      });
    } finally {
      this.processing = false;
    }
  }

  private async withQueueLock(work: () => Promise<void>): Promise<void> {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) {
      await work();
      return;
    }
    await locks.request(QUEUE_LOCK_NAME, { ifAvailable: true }, async (lock) => {
      // Another tab owns the queue; it will pick up our records via the channel.
      if (!lock) return;
      await work();
    });
  }

  private async runJob(key: string): Promise<void> {
    const controller = new AbortController();
    const { signal } = controller;
    this.controllers.set(key, controller);
    this.activeKey = key;

    try {
      const started = await this.update(key, { status: "downloading", error: null });
      if (!started) return;

      const dataCache = await caches.open(OFFLINE_CACHE_NAMES.data);
      const audioCache = await caches.open(OFFLINE_CACHE_NAMES.audio);
      const { catalogId, hash } = started;

      const entry = await fetchJsonAndStore<EntryResponse>(
        dataCache,
        buildRecordingEntryUrl(catalogId, hash),
        signal
      );
      const sources = await tryFetchJsonAndStore<SourcesResponse>(
        dataCache,
        buildAudioSourcesUrl(catalogId, hash),
        signal
      );
      const preference = await tryFetchJsonAndStore<PreferenceResponse>(
        dataCache,
        buildAudioSourcePreferenceUrl(catalogId, hash),
        signal
      );
      await tryFetchJsonAndStore(dataCache, buildPlaybackProgressUrl(catalogId, hash), signal);

      const availableSources = sources?.sources ?? [];
      const preferredSource =
        preference?.sourceId && availableSources.some((source) => source.id === preference.sourceId)
          ? preference.sourceId
          : null;
      const audioSource = preferredSource ?? sources?.defaultSource ?? "archived";
      const audioUrl = buildAudioUrl(catalogId, hash, audioSource, availableSources);
      const audioCacheKey = getAudioCacheKey(audioUrl, window.location.origin);

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

      let transcriptBackend: string | null = null;
      if (entry.canViewTranscripts) {
        transcriptBackend = await this.cacheTranscriptBundle(dataCache, catalogId, hash, signal);
      }

      let hasPoster = false;
      if (started.event) {
        hasPoster = await this.cacheEventBundle(dataCache, catalogId, started.event.id, signal);
        await cachePage(buildEventPagePath(catalogId, started.event.id), signal).catch((error) => {
          if (isAbortError(error) || isNetworkError(error)) throw error;
          logger.debug("Event page not cached", { error });
        });
      } else {
        await cachePage(buildRecordingPagePath(catalogId, hash), signal).catch((error) => {
          if (isAbortError(error) || isNetworkError(error)) throw error;
          logger.debug("Recording page not cached", { error });
        });
      }

      await this.update(key, {
        status: "complete",
        progress: 100,
        error: null,
        transcriptBackend,
        hasPoster,
        completedAt: Date.now(),
      });
    } catch (error) {
      if (signal.aborted) {
        // pause() or remove() already recorded the new state.
        return;
      }
      if (isNetworkError(error)) {
        logger.info("Download paused by network loss", { key });
        await this.update(key, { status: "paused", error: null });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("Download failed", { key, error });
        await this.update(key, { status: "error", error: message });
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

  private async cacheTranscriptBundle(
    dataCache: Cache,
    catalogId: string,
    hash: string,
    signal: AbortSignal
  ): Promise<string | null> {
    const backends = await tryFetchJsonAndStore<TranscriptBackendsResponse>(
      dataCache,
      buildTranscriptBackendsUrl(hash, catalogId),
      signal
    );
    const backend = backends?.backends[0];
    if (!backend) return null;

    await tryFetchAndStore(dataCache, buildTranscriptUrl(hash, catalogId, backend), signal);
    await tryFetchAndStore(dataCache, buildTranscriptFormatsUrl(hash, catalogId, backend), signal);

    const diarizations = await tryFetchJsonAndStore<DiarizationBackendsResponse>(
      dataCache,
      buildDiarizationBackendsUrl(hash, catalogId),
      signal
    );
    const diarizationBackend = diarizations?.backends.includes("pyannote")
      ? "pyannote"
      : diarizations?.backends[0];
    if (diarizationBackend) {
      await tryFetchAndStore(dataCache, buildDiarizationUrl(hash, catalogId, diarizationBackend), signal);
    }
    return backend;
  }

  private async cacheEventBundle(
    dataCache: Cache,
    catalogId: string,
    eventId: number,
    signal: AbortSignal
  ): Promise<boolean> {
    const event = await fetchJsonAndStore<EventDetailResponse>(
      dataCache,
      buildEventDetailUrl(catalogId, eventId),
      signal
    );
    const portraitExists = event.posterFiles?.portrait.exists ?? event.posterStatus?.portrait ?? false;
    const landscapeExists =
      event.posterFiles?.landscape.exists ?? event.posterStatus?.landscape ?? false;
    let hasPoster = false;
    if (portraitExists) {
      hasPoster =
        (await tryFetchAndStore(
          dataCache,
          buildEventPosterUrl(catalogId, eventId, "portrait", event.posterFiles?.portrait.uploadedAt),
          signal
        )) || hasPoster;
    }
    if (landscapeExists) {
      hasPoster =
        (await tryFetchAndStore(
          dataCache,
          buildEventPosterUrl(catalogId, eventId, "landscape", event.posterFiles?.landscape.uploadedAt),
          signal
        )) || hasPoster;
    }
    return hasPoster;
  }

  private async deleteBundle(record: DownloadRecord): Promise<void> {
    try {
      const audioCache = await caches.open(OFFLINE_CACHE_NAMES.audio);
      if (record.audioCacheKey) {
        await deleteAudioCacheEntries(audioCache, record.audioCacheKey);
      }

      const dataCache = await caches.open(OFFLINE_CACHE_NAMES.data);
      const shellCache = await caches.open(OFFLINE_CACHE_NAMES.shell);
      const dataKeys = await dataCache.keys();
      await Promise.all(
        dataKeys
          .filter((request) => request.url.includes(record.hash))
          .map((request) => dataCache.delete(request))
      );
      await shellCache.delete(buildRecordingPagePath(record.catalogId, record.hash));

      if (record.event && record.eventKey) {
        const stillReferenced = Array.from(this.records.values()).some(
          (other) => other.eventKey === record.eventKey
        );
        if (!stillReferenced) {
          const eventPattern = new RegExp(`/events/${record.event.id}(?:/|\\?|$)`);
          await Promise.all(
            dataKeys
              .filter((request) => {
                const pathname = new URL(request.url).pathname;
                return pathname.includes(`/catalogs/${record.catalogId}/`) && eventPattern.test(request.url);
              })
              .map((request) => dataCache.delete(request))
          );
          await shellCache.delete(buildEventPagePath(record.catalogId, record.event.id));
        }
      }
    } catch (error) {
      logger.warn("Failed to delete download data", { key: record.key, error });
    }
  }
}

export const downloadManager = new DownloadManager();

export type { DownloadRecord, DownloadStatus } from "./downloads-db";
