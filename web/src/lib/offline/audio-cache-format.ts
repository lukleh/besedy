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
}

/**
 * Normalize an audio URL into its cache key. Only `source` and `variant`
 * change the bytes served, so only they survive; `archived` is the default
 * source and is dropped so `…/audio` and `…/audio?source=archived` share one
 * entry.
 */
export function getAudioCacheKey(url: string, origin: string): string {
  const parsed = new URL(url, origin);
  const source = parsed.searchParams.get("source") || "archived";
  const variant = parsed.searchParams.get("variant") || "";

  parsed.search = "";
  parsed.hash = "";
  if (source !== "archived") {
    parsed.searchParams.set("source", source);
  }
  if (variant) {
    parsed.searchParams.set("variant", variant);
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
    };
  } catch {
    return null;
  }
}

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

/**
 * WebKit cannot play service-worker or blob-backed audio once the browser is
 * offline. Downloads retain bytes for an inline media source on Safari/iOS.
 */
export function requiresInlineOfflineAudio(userAgent: string): boolean {
  if (!/AppleWebKit\//.test(userAgent)) return false;
  if (/(?:iPhone|iPad|iPod)/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && /Version\/[^ ]+.*Safari\//.test(userAgent);
}

/** Assemble a complete cached recording without copying all chunks into one ArrayBuffer. */
export async function readCompleteAudioBlob(
  cache: Cache,
  baseKey: string,
): Promise<Blob | null> {
  const meta = await readAudioCacheMeta(cache, baseKey);
  if (!meta?.complete || meta.totalSize <= 0) return null;
  if (
    meta.chunkSizes.length === 0 ||
    meta.chunkSizes.reduce((sum, size) => sum + size, 0) !== meta.totalSize
  ) {
    return null;
  }

  const chunks: Blob[] = [];
  for (let index = 0; index < meta.chunkSizes.length; index += 1) {
    const response = await cache.match(getAudioChunkKey(baseKey, index));
    if (!response) return null;
    const chunk = await response.blob();
    if (chunk.size !== meta.chunkSizes[index]) return null;
    chunks.push(chunk);
  }
  return new Blob(chunks, { type: meta.contentType || 'audio/webm' });
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
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((request) => isAudioCacheEntryFor(baseKey, request.url))
      .map((request) => cache.delete(request))
  );
}
