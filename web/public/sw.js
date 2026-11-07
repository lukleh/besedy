/**
 * Besedy service worker (v11): local-mode shell and chunked audio.
 *
 * The worker intentionally knows nothing about catalog/event page data. Normal
 * application pages remain network-only. The page-side download manager stores
 * registry metadata and transcript/artwork payloads in IndexedDB and writes
 * audio chunks to Cache Storage. This worker only:
 *
 *   - serves complete downloaded audio with bounded-memory Range streaming;
 *   - stores and replays the one session-free /downloads document;
 *   - caches build assets actually requested by that offline root;
 *   - answers a failed normal navigation with that document at the requested
 *     URL, so the page can render a downloaded event from local data;
 *   - handles the existing update and push-notification protocols.
 */

const AUDIO_CACHE_NAME = 'besedy-audio-v5';
const SHELL_CACHE_NAME = 'besedy-offline-shell-v1';
const STATIC_CACHE_NAME = 'besedy-offline-static-v1';
const STATIC_CACHE_MAX_ENTRIES = 96;
const KNOWN_CACHE_NAMES = [
  AUDIO_CACHE_NAME,
  SHELL_CACHE_NAME,
  STATIC_CACHE_NAME,
];
const OWNED_CACHE_PREFIX = 'besedy-';

const CHUNK_SIZE = 2 * 1024 * 1024;
// A Range response carries at most this many bytes, however much the request
// asks for and however the recording is chunked. WebKit's media loader keeps
// every byte it is sent in the GPU process and does not stop reading a
// service-worker stream, so answering `bytes=0-` with the whole recording
// pushed that process past its memory limit on iPhone. A short 206 is a valid
// answer: the player asks for the next range when it needs it.
const MAX_RANGE_RESPONSE_BYTES = 4 * 1024 * 1024;
const AUDIO_URL_PATTERN =
  /\/api\/catalogs\/[^/]+\/recordings\/([a-f0-9]{64})\/audio$/;
const AUTH_NAVIGATION_PREFIXES = ['/api/auth/', '/mock-oauth/'];
const DOWNLOADS_PATH = '/downloads';
const OFFLINE_RESPONSE_HEADER = 'x-besedy-offline';
const IMMUTABLE_STATIC_PATTERN = /^\/_next\/static\//;
const APP_ASSET_PATTERNS = [
  /^\/manifest\.webmanifest$/,
  /^\/(?:icon-[^/]+\.(?:png|svg)|apple-touch-icon\.png|badge-72\.svg|favicon\.ico)$/,
];

self.addEventListener('install', () => {
  // Activation waits for SKIP_WAITING so the update banner stays in control.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                name.startsWith(OWNED_CACHE_PREFIX) &&
                !KNOWN_CACHE_NAMES.includes(name),
            )
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    case 'GET_WEB_VERSION':
      event.ports[0]?.postMessage({
        type: 'WEB_VERSION',
        version: self.__BESEDY_WEB_VERSION || null,
      });
      return;
    case 'SKIP_WAITING':
      self.skipWaiting();
      return;
    default:
      return;
  }
});

function isDownloadsPath(pathname) {
  return pathname === DOWNLOADS_PATH || pathname === `${DOWNLOADS_PATH}/`;
}

function isImmutableStaticPath(pathname) {
  return IMMUTABLE_STATIC_PATTERN.test(pathname);
}

function isAppAssetPath(pathname) {
  return APP_ASSET_PATTERNS.some((pattern) => pattern.test(pathname));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (AUDIO_URL_PATTERN.test(url.pathname)) {
    if (url.searchParams.get('download') === 'true') return;
    event.respondWith(handleAudioRequest(request));
    return;
  }

  if (request.mode === 'navigate') {
    if (
      AUTH_NAVIGATION_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
    ) {
      return;
    }
    event.respondWith(
      isDownloadsPath(url.pathname)
        ? handleDownloadsNavigation(request)
        : handleApplicationNavigation(request, url),
    );
    return;
  }

  if (isImmutableStaticPath(url.pathname)) {
    event.respondWith(handleImmutableStaticRequest(request, event.clientId));
    return;
  }

  if (isAppAssetPath(url.pathname)) {
    event.respondWith(handleAppAssetRequest(request));
  }
});

function isSameOriginResponse(response) {
  return response.type === 'basic' || response.type === 'default';
}

function withHeader(response, name, value) {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function markOffline(response) {
  return withHeader(response, OFFLINE_RESPONSE_HEADER, '1');
}

async function storeDownloadsShell(response) {
  if (
    !response.ok ||
    response.redirected ||
    !isSameOriginResponse(response) ||
    !(response.headers.get('content-type') || '').includes('text/html')
  ) {
    return;
  }
  const cache = await caches.open(SHELL_CACHE_NAME);
  const body = await response.arrayBuffer();
  await cache.put(
    DOWNLOADS_PATH,
    new Response(body, {
      status: 200,
      headers: {
        'content-type':
          response.headers.get('content-type') || 'text/html; charset=utf-8',
      },
    }),
  );
}

async function matchDownloadsShell() {
  const cache = await caches.open(SHELL_CACHE_NAME);
  return cache.match(DOWNLOADS_PATH, { ignoreVary: true });
}

async function handleDownloadsNavigation(request) {
  try {
    const response = await fetch(request, {
      credentials: 'include',
      cache: 'no-store',
    });
    await storeDownloadsShell(response.clone());
    return response;
  } catch (error) {
    const cached = await matchDownloadsShell();
    if (cached) return markOffline(cached);
    console.log('[SW] Downloads shell unavailable:', error && error.message);
    return offlineFallbackResponse();
  }
}

async function handleApplicationNavigation(request, url) {
  try {
    return await fetch(request, {
      credentials: 'include',
      cache: 'no-store',
    });
  } catch (error) {
    // The session-free document is a transport fallback, not a redirect: the
    // URL stays what the person asked for and the page resolves it against the
    // local download packages.
    const cached = await matchDownloadsShell();
    if (cached) return markOffline(cached);
    console.log(
      '[SW] Navigation failed without an offline shell:',
      url.pathname,
      error && error.message,
    );
    return offlineFallbackResponse();
  }
}

function offlineFallbackResponse() {
  return new Response(OFFLINE_FALLBACK_HTML, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      [OFFLINE_RESPONSE_HEADER]: '1',
    },
  });
}

const OFFLINE_FALLBACK_HTML = [
  '<!DOCTYPE html>',
  '<html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="color-scheme" content="light dark">',
  '<title>Besedy</title>',
  '<style>',
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
  "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#fff;color:#0a0a0a;padding:24px;box-sizing:border-box}",
  '@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#fafafa}}',
  'main{max-width:26rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:0 0 1.25rem;opacity:.75;line-height:1.5}',
  'button{font:inherit;padding:.65rem 1.25rem;border-radius:999px;border:2px solid currentColor;background:transparent;color:inherit;cursor:pointer}',
  '</style></head><body><main>',
  "<h1>You're offline</h1>",
  '<p>Jste offline. Open Downloads online once before relying on offline playback.</p>',
  '<button type="button" onclick="location.reload()">Try again · Zkusit znovu</button>',
  '</main></body></html>',
].join('');

async function isDownloadsClientRequest(request, clientId) {
  if (clientId && self.clients.get) {
    const client = await self.clients.get(clientId).catch(() => null);
    if (client && isDownloadsPath(new URL(client.url).pathname)) {
      return true;
    }
  }
  if (!request.referrer) return false;
  try {
    return isDownloadsPath(new URL(request.referrer).pathname);
  } catch {
    return false;
  }
}

async function trimStaticCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - STATIC_CACHE_MAX_ENTRIES;
  if (excess > 0) {
    await Promise.all(
      keys.slice(0, excess).map((request) => cache.delete(request)),
    );
  }
}

async function handleImmutableStaticRequest(request, clientId) {
  const cache = await caches.open(STATIC_CACHE_NAME);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (
    response.ok &&
    isSameOriginResponse(response) &&
    (await isDownloadsClientRequest(request, clientId))
  ) {
    await cache.put(request, response.clone()).catch((error) => {
      console.warn(
        '[SW] Failed to cache offline build asset',
        request.url,
        error,
      );
    });
    await trimStaticCache(cache).catch(() => {});
  }
  return response;
}

async function handleAppAssetRequest(request) {
  const cache = await caches.open(STATIC_CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok && isSameOriginResponse(response)) {
      await cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return markOffline(cached);
    throw error;
  }
}

// Must match getAudioCacheKey in src/lib/offline/audio-cache-format.ts: the
// AAC-in-MP4 copy (`format=aac`, #291) is a different file from the WebM.
function getCacheKey(url) {
  const parsed = new URL(url, self.location.origin);
  const source = parsed.searchParams.get('source') || 'archived';
  const variant = parsed.searchParams.get('variant') || '';
  const format = parsed.searchParams.get('format') || 'webm';

  parsed.search = '';
  parsed.hash = '';
  if (source !== 'archived') {
    parsed.searchParams.set('source', source);
  }
  if (variant) {
    parsed.searchParams.set('variant', variant);
  }
  if (format !== 'webm') {
    parsed.searchParams.set('format', format);
  }
  return parsed.toString();
}

function getChunkKey(baseKey, chunkIndex) {
  const separator = baseKey.includes('?') ? '&' : '?';
  return `${baseKey}${separator}_chunk=${chunkIndex}`;
}

function getMetaKey(baseKey) {
  const separator = baseKey.includes('?') ? '&' : '?';
  return `${baseKey}${separator}_meta`;
}

function isAudioCacheEntryFor(baseKey, entryUrl) {
  if (!entryUrl.startsWith(baseKey)) return false;
  const suffix = entryUrl.slice(baseKey.length);
  return (
    suffix === '?_meta' ||
    suffix === '&_meta' ||
    suffix.startsWith('?_chunk=') ||
    suffix.startsWith('&_chunk=')
  );
}

// Raised only when the cached bytes themselves are wrong. Any other failure
// while reading Cache Storage (quota pressure, the worker being torn down)
// says nothing about the download and must not discard it.
class DamagedDownloadError extends Error {}

function getAudioCacheLockName(baseKey) {
  return `besedy-audio-cache:${baseKey}`;
}

async function deleteAudioCacheEntries(cache, baseKey, metaIdentity) {
  // An identity check alone can race a page's next write. Without a shared
  // lock, fail the response but retain bytes rather than risk a replacement.
  const locks = self.navigator?.locks;
  if (!locks) {
    console.warn('[SW] Web Locks unavailable; keeping damaged audio cache entries for', baseKey);
    return;
  }
  try {
    await locks.request(getAudioCacheLockName(baseKey), async () => {
      const current = await cache.match(getMetaKey(baseKey));
      if (!current || (await current.text()) !== metaIdentity) return;
      const keys = await cache.keys();
      await Promise.all(
        keys
          .filter((request) => isAudioCacheEntryFor(baseKey, request.url))
          .map((request) => cache.delete(request)),
      );
    });
  } catch (error) {
    console.error('[SW] Audio cache cleanup failed:', error);
  }
}

function isWellFormedAudioMeta(meta) {
  return (
    meta &&
    typeof meta === 'object' &&
    typeof meta.complete === 'boolean' &&
    Number.isFinite(meta.totalSize) &&
    meta.totalSize > 0 &&
    typeof meta.contentType === 'string' &&
    Array.isArray(meta.chunkSizes) &&
    meta.chunkSizes.length > 0 &&
    meta.chunkSizes.every((size) => Number.isFinite(size) && size > 0)
  );
}

async function handleAudioRequest(request) {
  const cache = await caches.open(AUDIO_CACHE_NAME);
  const cacheKey = getCacheKey(request.url);
  const metaResponse = await cache.match(getMetaKey(cacheKey));
  if (!metaResponse) return fetch(request);

  let metaIdentity;
  try {
    metaIdentity = await metaResponse.text();
  } catch {
    // A body that cannot be read says nothing about the download: serve the
    // network and keep the bytes.
    return fetch(request);
  }
  let meta;
  try {
    meta = JSON.parse(metaIdentity);
  } catch {
    await deleteAudioCacheEntries(cache, cacheKey, metaIdentity);
    return fetch(request);
  }
  if (!isWellFormedAudioMeta(meta)) {
    await deleteAudioCacheEntries(cache, cacheKey, metaIdentity);
    return fetch(request);
  }
  // The page-side manager's own Range requests pass through this worker while
  // it is still writing chunks. Incomplete metadata is valid resumable state:
  // use the network without deleting bytes that are actively being assembled.
  if (!meta.complete) return fetch(request);
  return handleRangeFromChunks(
    cache,
    cacheKey,
    meta,
    metaIdentity,
    request.headers.get('range'),
    request,
  );
}

/**
 * Parse one RFC 9110 byte range. Multi-range responses are deliberately not
 * implemented; malformed or reversed ranges are rejected instead of silently
 * materializing the full recording.
 */
function parseRangeHeader(rangeHeader, totalSize) {
  if (!rangeHeader) return { kind: 'full' };
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { kind: 'invalid' };

  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return { kind: 'invalid' };

  if (!hasStart) {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0)
      return { kind: 'unsatisfiable' };
    return {
      kind: 'range',
      start: Math.max(0, totalSize - suffixLength),
      end: totalSize - 1,
      suffix: true,
    };
  }

  const start = Number.parseInt(match[1], 10);
  if (!Number.isFinite(start) || start >= totalSize)
    return { kind: 'unsatisfiable' };
  const end = hasEnd
    ? Math.min(Number.parseInt(match[2], 10), totalSize - 1)
    : totalSize - 1;
  if (!Number.isFinite(end) || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}

function unsatisfiableRangeResponse(totalSize) {
  return new Response(null, {
    status: 416,
    headers: { 'Content-Range': `bytes */${totalSize}` },
  });
}

/**
 * Stream at most one cached chunk into memory at a time. In particular,
 * Range: bytes=0- no longer concatenates a whole multi-hour recording in the
 * service worker before playback can begin.
 */
function createChunkStream(options) {
  const {
    cache,
    baseKey,
    metaIdentity,
    chunkSizes,
    chunkOffsets,
    startChunk,
    endChunk,
    start,
    end,
  } = options;
  let chunkIndex = startChunk;
  let cancelled = false;

  return new ReadableStream(
    {
      async pull(controller) {
        if (chunkIndex > endChunk) {
          controller.close();
          return;
        }

        try {
          const response = await cache.match(getChunkKey(baseKey, chunkIndex));
          if (!response) {
            throw new DamagedDownloadError(`Missing audio chunk ${chunkIndex}`);
          }
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength !== chunkSizes[chunkIndex]) {
            throw new DamagedDownloadError(
              `Audio chunk ${chunkIndex} has ${bytes.byteLength} bytes; expected ${chunkSizes[chunkIndex]}`,
            );
          }

          // Media elements cancel responses on every seek and after reading the
          // headers. A chunk read that finishes afterwards is simply dropped:
          // enqueueing it would throw, and that is not a damaged download.
          if (cancelled) return;

          const absoluteChunkStart = chunkOffsets[chunkIndex];
          const from = Math.max(0, start - absoluteChunkStart);
          const to = Math.min(bytes.byteLength, end - absoluteChunkStart + 1);
          controller.enqueue(new Uint8Array(bytes, from, to - from));
          chunkIndex += 1;
          if (chunkIndex > endChunk) controller.close();
        } catch (error) {
          // Damaged bytes are damage even if the player has already moved on;
          // erroring a cancelled stream is a no-op.
          if (error instanceof DamagedDownloadError) {
            await deleteAudioCacheEntries(cache, baseKey, metaIdentity);
          }
          controller.error(error);
        }
      },
      cancel() {
        cancelled = true;
      },
    },
    // No read-ahead: the first chunk is only read once the player asks for
    // bytes, so a header-only probe or an immediately cancelled seek costs
    // nothing.
    { highWaterMark: 0 },
  );
}

async function handleRangeFromChunks(
  cache,
  baseKey,
  meta,
  metaIdentity,
  rangeHeader,
  request,
) {
  const { totalSize, contentType, chunkSizes } = meta;
  const chunkOffsets = [0];
  for (let index = 0; index < chunkSizes.length; index += 1) {
    chunkOffsets.push(chunkOffsets[index] + chunkSizes[index]);
  }
  if (chunkOffsets[chunkSizes.length] !== totalSize) {
    await deleteAudioCacheEntries(cache, baseKey, metaIdentity);
    return fetch(request);
  }

  const parsed = parseRangeHeader(rangeHeader, totalSize);
  if (parsed.kind === 'invalid' || parsed.kind === 'unsatisfiable') {
    return unsatisfiableRangeResponse(totalSize);
  }
  const isRangeRequest = parsed.kind === 'range';
  const requestedStart = isRangeRequest ? parsed.start : 0;
  const requestedEnd = isRangeRequest ? parsed.end : totalSize - 1;
  // A request without Range must get the whole body as a 200; only a 206 may
  // be shorter than asked for. A suffix range asks for the tail, so it keeps
  // its end rather than its start.
  let start = requestedStart;
  let end = requestedEnd;
  if (isRangeRequest && end - start + 1 > MAX_RANGE_RESPONSE_BYTES) {
    if (parsed.suffix) start = end - MAX_RANGE_RESPONSE_BYTES + 1;
    else end = start + MAX_RANGE_RESPONSE_BYTES - 1;
  }

  const chunkAt = (offset) => {
    for (let index = 0; index < chunkSizes.length; index += 1) {
      if (offset < chunkOffsets[index + 1]) return index;
    }
    return -1;
  };
  const startChunk = chunkAt(start);
  const endChunk = chunkAt(end);
  const firstRequestedChunk = chunkAt(requestedStart);
  const lastRequestedChunk = chunkAt(requestedEnd);
  if (
    startChunk === -1 ||
    endChunk === -1 ||
    firstRequestedChunk === -1 ||
    lastRequestedChunk === -1
  ) {
    await deleteAudioCacheEntries(cache, baseKey, metaIdentity);
    return fetch(request);
  }

  // Check every chunk the request asked for, not only the ones this capped
  // response carries: a gap found now falls back to the network before any
  // byte is committed, instead of deleting the cache under a playing element
  // several ranges later.
  for (let index = firstRequestedChunk; index <= lastRequestedChunk; index += 1) {
    if (!(await cache.match(getChunkKey(baseKey, index)))) {
      await deleteAudioCacheEntries(cache, baseKey, metaIdentity);
      return fetch(request);
    }
  }

  const body = createChunkStream({
    cache,
    baseKey,
    metaIdentity,
    chunkSizes,
    chunkOffsets,
    startChunk,
    endChunk,
    start,
    end,
  });
  return new Response(body, {
    status: isRangeRequest ? 206 : 200,
    headers: {
      'Content-Type': contentType || 'audio/webm',
      'Content-Length': String(end - start + 1),
      ...(isRangeRequest
        ? { 'Content-Range': `bytes ${start}-${end}/${totalSize}` }
        : {}),
      'Accept-Ranges': 'bytes',
      [OFFLINE_RESPONSE_HEADER]: '1',
    },
  });
}

self.__BESEDY_SW_INTERNALS = {
  AUDIO_CACHE_NAME,
  SHELL_CACHE_NAME,
  STATIC_CACHE_NAME,
  STATIC_CACHE_MAX_ENTRIES,
  CHUNK_SIZE,
  MAX_RANGE_RESPONSE_BYTES,
  DOWNLOADS_PATH,
  OFFLINE_RESPONSE_HEADER,
  getCacheKey,
  getChunkKey,
  getMetaKey,
  getAudioCacheLockName,
  isAudioCacheEntryFor,
  isDownloadsPath,
  parseRangeHeader,
};

// =============================================================================
// Push notifications
// =============================================================================

self.addEventListener('push', (event) => {
  let data = {
    title: 'Besedy',
    body: 'New content available',
    icon: '/icon-192.svg',
    badge: '/badge-72.svg',
    tag: 'besedy-update',
    data: { url: '/catalog' },
  };

  if (event.data) {
    try {
      const payload = event.data.json();
      data = { ...data, ...payload };
    } catch (error) {
      console.error('[SW] Failed to parse push data:', error);
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/icon-192.svg',
    badge: data.badge || '/badge-72.svg',
    tag: data.tag || 'besedy-update',
    data: data.data || { url: '/catalog' },
    vibrate: [100, 50, 100],
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

function isValidNotificationUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('/')) return true;
  try {
    const parsed = new URL(url, self.location.origin);
    return parsed.origin === self.location.origin;
  } catch {
    return false;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const rawUrl = event.notification.data?.url;
  const url = isValidNotificationUrl(rawUrl) ? rawUrl : '/catalog';

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
      }),
  );
});
