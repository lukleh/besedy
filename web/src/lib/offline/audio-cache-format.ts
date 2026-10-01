/**
 * On-disk format of downloaded audio in Cache Storage.
 *
 * Audio is stored as fixed-size Range chunks plus one JSON metadata entry so a
 * phone never has to hold a whole file in memory. The download manager writes
 * this format from the page; the service worker (`public/sw.js`) reads it to
 * answer Range requests. Both must agree on every key and field here, so the
 * worker repeats these helpers verbatim and the unit tests compare them.
 *
 * Keys, for a base key B (the audio URL without cache-irrelevant params):
 *   - `${B}?_meta`      metadata JSON (or `${B}&_meta` when B has a query)
 *   - `${B}?_chunk=N`   chunk N as application/octet-stream
 */
import { OFFLINE_CACHE_NAMES } from "./cache-names";

export const AUDIO_CACHE_NAME = OFFLINE_CACHE_NAMES.audio;
export const AUDIO_CHUNK_SIZE = 2 * 1024 * 1024;
/** Matches the streaming endpoint pathname only, not `/audio/sources`. */
export const AUDIO_URL_PATTERN = /\/api\/catalogs\/[^/]+\/recordings\/([a-f0-9]{64})\/audio$/;

export interface AudioCacheMeta {
  totalSize: number;
  chunkCount: number;
  chunkSizes: number[];
  contentType: string;
  complete: boolean;
  /** Changes on restart/repair so old playback failures cannot delete new bytes. */
  generation?: string;
}

/**
 * A cache key without its `format`: the recording and source it stores.
 * Used to recognise a download of the same source in the other format.
 */
export function withoutAudioFormat(cacheKey: string): string {
  const parsed = new URL(cacheKey);
  parsed.searchParams.delete("format");
  return parsed.toString();
}

/** Shared with the worker; never hold this lock across a network request. */
export function getAudioCacheLockName(baseKey: string): string {
  return `besedy-audio-cache:${baseKey}`;
}

export async function withAudioCacheLock<T>(
  baseKey: string,
  work: () => Promise<T>,
): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks ? locks.request(getAudioCacheLockName(baseKey), work) : work();
}

/**
 * Normalize an audio URL into its cache key. Only `source`, `variant` and
 * `format` change the bytes served, so only they survive. The defaults
 * (`archived`, `webm`) are dropped so `…/audio` and `…/audio?source=archived`
 * share one entry, and so WebM packages downloaded before `format` existed
 * keep their keys; the AAC-in-MP4 copy (#291) gets its own.
 */
export function getAudioCacheKey(url: string, origin: string): string {
  const parsed = new URL(url, origin);
  const source = parsed.searchParams.get("source") || "archived";
  const variant = parsed.searchParams.get("variant") || "";
  const format = parsed.searchParams.get("format") || "webm";

  parsed.search = "";
  parsed.hash = "";
  if (source !== "archived") {
    parsed.searchParams.set("source", source);
  }
  if (variant) {
    parsed.searchParams.set("variant", variant);
  }
  if (format !== "webm") {
    parsed.searchParams.set("format", format);
  }
  return parsed.toString();
}

export function getAudioChunkKey(baseKey: string, chunkIndex: number): string {
  const separator = baseKey.includes("?") ? "&" : "?";
  return `${baseKey}${separator}_chunk=${chunkIndex}`;
}

export function getAudioMetaKey(baseKey: string): string {
  const separator = baseKey.includes("?") ? "&" : "?";
  return `${baseKey}${separator}_meta`;
}

/** True when `entryUrl` is the meta entry or a chunk entry of `baseKey`. */
export function isAudioCacheEntryFor(baseKey: string, entryUrl: string): boolean {
  if (!entryUrl.startsWith(baseKey)) return false;
  const suffix = entryUrl.slice(baseKey.length);
  return (
    suffix === "?_meta" ||
    suffix === "&_meta" ||
    suffix.startsWith("?_chunk=") ||
    suffix.startsWith("&_chunk=")
  );
}

export function extractAudioHashFromKey(baseKey: string): string | null {
  const match = baseKey.match(/\/recordings\/([a-f0-9]{64})\/audio/);
  return match ? match[1] : null;
}

function isValidMeta(value: unknown): value is AudioCacheMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<AudioCacheMeta>;
  return (
    typeof meta.totalSize === "number" &&
    Number.isFinite(meta.totalSize) &&
    meta.totalSize >= 0 &&
    Array.isArray(meta.chunkSizes) &&
    meta.chunkSizes.every((size) => typeof size === "number" && size >= 0) &&
    typeof meta.contentType === "string"
  );
}

export async function readAudioCacheMeta(
  cache: Cache,
  baseKey: string
): Promise<AudioCacheMeta | null> {
  const response = await cache.match(getAudioMetaKey(baseKey));
  if (!response) return null;
  try {
    const parsed: unknown = await response.json();
    if (!isValidMeta(parsed)) return null;
    return {
      totalSize: parsed.totalSize,
      chunkCount: parsed.chunkSizes.length,
      chunkSizes: parsed.chunkSizes,
      contentType: parsed.contentType,
      complete: parsed.complete === true,
      ...(typeof parsed.generation === 'string'
        ? { generation: parsed.generation }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Call under withAudioCacheLock when updating a download's stored state. */
export async function writeAudioCacheMeta(
  cache: Cache,
  baseKey: string,
  meta: AudioCacheMeta
): Promise<void> {
  await cache.put(
    getAudioMetaKey(baseKey),
    new Response(JSON.stringify(meta), {
      headers: { "Content-Type": "application/json" },
    })
  );
}

/** Sum of the recorded chunk sizes. */
export function audioCacheMetaBytes(meta: Pick<AudioCacheMeta, 'chunkSizes'>): number {
  return meta.chunkSizes.reduce((sum, size) => sum + size, 0);
}

/**
 * Invariants shared by verification and resume: a positive total, at least
 * one chunk, every chunk non-empty, and the chunks never exceeding the total.
 * The completion flag must agree with the bytes recorded.
 */
export function isConsistentAudioCacheMeta(meta: AudioCacheMeta): boolean {
  if (meta.totalSize <= 0 || meta.chunkSizes.length === 0) return false;
  if (meta.chunkSizes.some((size) => !Number.isInteger(size) || size <= 0)) {
    return false;
  }
  const bytes = audioCacheMetaBytes(meta);
  if (bytes > meta.totalSize) return false;
  return meta.complete === (bytes === meta.totalSize);
}

/**
 * Whether the cache holds a complete recording for `baseKey`: consistent,
 * complete metadata and every chunk present. Presence is enough here; the
 * worker validates chunk lengths when it serves them.
 */
export async function verifyAudioCache(
  cache: Cache,
  baseKey: string,
): Promise<boolean> {
  const meta = await readAudioCacheMeta(cache, baseKey);
  if (!meta || !meta.complete || !isConsistentAudioCacheMeta(meta)) return false;
  for (let index = 0; index < meta.chunkSizes.length; index += 1) {
    if (!(await cache.match(getAudioChunkKey(baseKey, index)))) return false;
  }
  return true;
}

export interface AudioCacheProgress {
  bytesLoaded: number;
  totalBytes: number;
  /** 0-100, capped at 99 until `complete` is true. */
  progress: number;
  complete: boolean;
}

export function summarizeAudioCacheMeta(meta: AudioCacheMeta): AudioCacheProgress {
  const bytesLoaded = meta.chunkSizes.reduce((sum, size) => sum + size, 0);
  const complete = meta.complete && bytesLoaded >= meta.totalSize && meta.totalSize > 0;
  const ratio = meta.totalSize > 0 ? bytesLoaded / meta.totalSize : 0;
  return {
    bytesLoaded,
    totalBytes: meta.totalSize,
    progress: complete ? 100 : Math.min(99, Math.floor(ratio * 100)),
    complete,
  };
}

/** Remove every chunk and the metadata entry stored for `baseKey`. */
export async function deleteAudioCacheEntries(cache: Cache, baseKey: string): Promise<void> {
  await withAudioCacheLock(baseKey, async () => {
    const keys = await cache.keys();
    await Promise.all(
      keys
        .filter((request) => isAudioCacheEntryFor(baseKey, request.url))
        .map((request) => cache.delete(request))
    );
  });
}
