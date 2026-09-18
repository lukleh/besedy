/**
 * Cache Storage names shared by the page-side download manager and the
 * service worker. `public/sw.js` cannot import modules, so it repeats these
 * values; `tests/unit/service-worker-script.test.ts` keeps the two in sync.
 */
export const OFFLINE_CACHE_NAMES = {
  /** Chunked audio, see audio-cache-format.ts. */
  audio: 'besedy-audio-v5',
  /** The single session-free `/downloads` document. */
  shell: 'besedy-offline-shell-v1',
  /** Build assets actually loaded by the offline root. */
  static: 'besedy-offline-static-v1',
} as const;

export type OfflineCacheName =
  (typeof OFFLINE_CACHE_NAMES)[keyof typeof OFFLINE_CACHE_NAMES];

export const OFFLINE_CACHE_PREFIX = 'besedy-';

/** Caches that hold protected content and must be cleared on sign-out. */
export const PROTECTED_OFFLINE_CACHE_NAMES: readonly OfflineCacheName[] = [
  OFFLINE_CACHE_NAMES.audio,
  OFFLINE_CACHE_NAMES.shell,
];

/** Set on responses the service worker served from local storage. */
export const OFFLINE_RESPONSE_HEADER = 'x-besedy-offline';

export const DOWNLOADS_PATH = '/downloads';
