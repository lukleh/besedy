/**
 * Cache Storage names shared by the page-side download manager and the
 * service worker. `public/sw.js` cannot import modules, so it repeats these
 * values; `tests/unit/service-worker-script.test.ts` keeps the two in sync.
 */
export const OFFLINE_CACHE_NAMES = {
  /** Chunked audio, see audio-cache-format.ts. */
  audio: "besedy-audio-v5",
  /** JSON API responses and posters keyed by exact request URL. */
  data: "besedy-data-v1",
  /** Page HTML keyed by pathname. */
  shell: "besedy-shell-v1",
  /** Immutable build assets under /_next/static plus the manifest and icons. */
  static: "besedy-static-v1",
} as const;

export type OfflineCacheName =
  (typeof OFFLINE_CACHE_NAMES)[keyof typeof OFFLINE_CACHE_NAMES];

export const OFFLINE_CACHE_PREFIX = "besedy-";

/** Caches that hold protected content and must be cleared on sign-out. */
export const PROTECTED_OFFLINE_CACHE_NAMES: readonly OfflineCacheName[] = [
  OFFLINE_CACHE_NAMES.audio,
  OFFLINE_CACHE_NAMES.data,
  OFFLINE_CACHE_NAMES.shell,
];

/** Set on responses the service worker served from cache because the network failed. */
export const OFFLINE_RESPONSE_HEADER = "x-besedy-offline";

/** Stamped on stored responses so stale entries can be pruned. */
export const CACHED_AT_HEADER = "x-besedy-cached-at";

export const DOWNLOADS_PATH = "/downloads";
