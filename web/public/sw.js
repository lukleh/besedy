/**
 * Besedy service worker (v10): offline shell, cached data fallback, and
 * chunked audio serving. See docs/web/offline.md for the full model.
 *
 * This worker never downloads anything on its own. The page-side download
 * manager (src/lib/offline/download-manager.ts) writes audio chunks, JSON
 * responses, page HTML, and build assets into the caches below; the worker
 * only reads them. Cache names, the audio chunk layout, and the data
 * allow-list are mirrored from src/lib/offline and checked by
 * tests/unit/service-worker-script.test.ts.
 *
 * Routing:
 *   - audio streaming endpoint     serve Range requests from complete chunk caches
 *   - navigations                  network-first; store shell routes; offline fallback
 *   - /_next/static/*              cache-first (content-hashed)
 *   - manifest + icons             network-first with cache fallback
 *   - allow-listed GET /api/* JSON network-first; store 2xx; cache fallback when offline
 *
 * Messages: GET_WEB_VERSION (reply on the provided port) and SKIP_WAITING.
 * Push notifications and notification clicks are handled at the bottom.
 */

const AUDIO_CACHE_NAME = "besedy-audio-v5";
const DATA_CACHE_NAME = "besedy-data-v1";
const SHELL_CACHE_NAME = "besedy-shell-v1";
const STATIC_CACHE_NAME = "besedy-static-v1";
const KNOWN_CACHE_NAMES = [AUDIO_CACHE_NAME, DATA_CACHE_NAME, SHELL_CACHE_NAME, STATIC_CACHE_NAME];
const OWNED_CACHE_PREFIX = "besedy-";

const CHUNK_SIZE = 2 * 1024 * 1024;
const AUDIO_URL_PATTERN = /\/api\/catalogs\/[^/]+\/recordings\/([a-f0-9]{64})\/audio$/;
const AUTH_NAVIGATION_PREFIXES = ["/api/auth/", "/mock-oauth/"];
const DOWNLOADS_PATH = "/downloads";
const OFFLINE_RESPONSE_HEADER = "x-besedy-offline";
const CACHED_AT_HEADER = "x-besedy-cached-at";
const DATA_CACHE_MAX_ENTRIES = 600;

/** Pages whose HTML is stored on successful navigation and served offline. */
const SHELL_PATH_PATTERNS = [
  /^\/catalog\/?$/,
  /^\/catalog\/[^/]+\/?$/,
  /^\/catalog\/[^/]+\/event\/\d+\/?$/,
  /^\/catalog\/[^/]+\/recording\/[a-f0-9]{64}\/?$/,
  /^\/downloads\/?$/,
];

/** Content-hashed build output: safe to serve cache-first forever. */
const IMMUTABLE_STATIC_PATTERN = /^\/_next\/static\//;

/** Small unversioned assets: network-first, cache fallback. */
const APP_ASSET_PATTERNS = [
  /^\/manifest\.webmanifest$/,
  /^\/(?:icon-[^/]+\.(?:png|svg)|apple-touch-icon\.png|badge-72\.svg|favicon\.ico)$/,
];

/**
 * GET JSON endpoints the offline pages need. Only these are stored, and only
 * successful responses. Mutations, auth flows other than the session read,
 * version probes, admin, MCP, and telemetry are never cached.
 */
const DATA_PATH_PATTERNS = [
  /^\/api\/auth\/get-session$/,
  /^\/api\/catalogs\/?$/,
  /^\/api\/catalogs\/[^/]+\/(?:features|capability)$/,
  /^\/api\/catalogs\/[^/]+\/events\/\d+(?:\/recordings|\/poster)?$/,
  /^\/api\/catalogs\/[^/]+\/recordings\/[a-f0-9]{64}\/(?:entry|progress|metadata|audio\/sources)$/,
  /^\/api\/catalog-events$/,
  /^\/api\/catalog$/,
  /^\/api\/transcript\/[a-f0-9]{64}(?:\/(?:formats|speakers))?$/,
  /^\/api\/preferences(?:\/audio-source|\/labs)?$/,
  /^\/api\/me\/permissions$/,
  /^\/api\/metadata\/(?:locations|recorders|albums)$/,
  /^\/api\/notifications$/,
];

let dataCacheWrites = 0;

// =============================================================================
// Lifecycle
// =============================================================================

self.addEventListener("install", () => {
  // Activation waits for SKIP_WAITING so the update banner stays in control.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(OWNED_CACHE_PREFIX) && !KNOWN_CACHE_NAMES.includes(name))
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  switch (data.type) {
    case "GET_WEB_VERSION":
      event.ports[0]?.postMessage({
        type: "WEB_VERSION",
        version: self.__BESEDY_WEB_VERSION || null,
      });
      return;
    case "SKIP_WAITING":
      self.skipWaiting();
      return;
    default:
      return;
  }
});

// =============================================================================
// Routing
// =============================================================================

function isShellPath(pathname) {
  return SHELL_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

function isImmutableStaticPath(pathname) {
  return IMMUTABLE_STATIC_PATTERN.test(pathname);
}

function isAppAssetPath(pathname) {
  return APP_ASSET_PATTERNS.some((pattern) => pattern.test(pathname));
}

function isCacheableDataPath(pathname) {
  return DATA_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

function isCacheableDataRequest(request, url) {
  if (request.method !== "GET") return false;
  if (!isCacheableDataPath(url.pathname)) return false;
  // Server-component payload fetches carry an RSC header and are not JSON API calls.
  if (request.headers.get("RSC")) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (AUDIO_URL_PATTERN.test(url.pathname)) {
    // Downloads need the server's Content-Disposition header.
    if (url.searchParams.get("download") === "true") return;
    event.respondWith(handleAudioRequest(request));
    return;
  }

  if (request.mode === "navigate") {
    if (AUTH_NAVIGATION_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      return;
    }
    event.respondWith(handleNavigationRequest(request, url));
    return;
  }

  if (isImmutableStaticPath(url.pathname)) {
    event.respondWith(handleImmutableStaticRequest(request));
    return;
  }

  if (isAppAssetPath(url.pathname)) {
    event.respondWith(handleAppAssetRequest(request));
    return;
  }

  if (isCacheableDataRequest(request, url)) {
    event.respondWith(handleDataRequest(request));
  }
});

// =============================================================================
// Shared cache helpers
// =============================================================================

/**
 * True for responses fetched from our own origin. Same-origin fetches report
 * "basic" in browsers; "default" covers constructed responses and Node.
 * Opaque, opaque-redirect, and error responses are never stored.
 */
function isSameOriginResponse(response) {
  return response.type === "basic" || response.type === "default";
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
  return withHeader(response, OFFLINE_RESPONSE_HEADER, "1");
}

/**
 * Store a response body under `key`, re-materialized so Vary and Set-Cookie
 * headers never interfere with matching. Failures are logged and swallowed;
 * the live response has already been returned to the page.
 */
async function storeResponse(cacheName, key, response) {
  try {
    const cache = await caches.open(cacheName);
    const body = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    await cache.put(
      key,
      new Response(body, {
        status: 200,
        headers: {
          "content-type": contentType,
          [CACHED_AT_HEADER]: String(Date.now()),
        },
      })
    );
  } catch (error) {
    console.warn("[SW] Failed to store response", key, error);
  }
}

async function matchCached(cacheName, key) {
  const cache = await caches.open(cacheName);
  return cache.match(key, { ignoreVary: true });
}

// =============================================================================
// Navigations
// =============================================================================

async function handleNavigationRequest(request, url) {
  try {
    const response = await fetch(request, {
      credentials: "include",
      cache: "no-store",
    });
    if (
      response.ok &&
      isSameOriginResponse(response) &&
      isShellPath(url.pathname) &&
      (response.headers.get("content-type") || "").includes("text/html")
    ) {
      await storeResponse(SHELL_CACHE_NAME, url.pathname, response.clone());
    }
    return response;
  } catch (error) {
    console.log("[SW] Navigation failed, using offline fallback:", url.pathname, error && error.message);
    return offlineNavigationFallback(url);
  }
}

async function offlineNavigationFallback(url) {
  const exact = await matchCached(SHELL_CACHE_NAME, url.pathname);
  if (exact) {
    return markOffline(exact);
  }

  if (url.pathname !== DOWNLOADS_PATH) {
    const downloads = await matchCached(SHELL_CACHE_NAME, DOWNLOADS_PATH);
    if (downloads) {
      const target = new URL(DOWNLOADS_PATH, self.location.origin);
      target.searchParams.set("from", url.pathname + url.search);
      return Response.redirect(target.toString(), 302);
    }
  }

  return new Response(OFFLINE_FALLBACK_HTML, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      [OFFLINE_RESPONSE_HEADER]: "1",
    },
  });
}

const OFFLINE_FALLBACK_HTML = [
  "<!DOCTYPE html>",
  '<html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="color-scheme" content="light dark">',
  "<title>Besedy</title>",
  "<style>",
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;",
  "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#fff;color:#0a0a0a;padding:24px;box-sizing:border-box}",
  "@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#fafafa}}",
  "main{max-width:26rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:0 0 1.25rem;opacity:.75;line-height:1.5}",
  "button{font:inherit;padding:.65rem 1.25rem;border-radius:999px;border:2px solid currentColor;background:transparent;color:inherit;cursor:pointer}",
  "</style></head><body><main>",
  "<h1>You're offline</h1>",
  "<p>Jste offline. This page is not available without a connection, and nothing has been downloaded yet.</p>",
  '<button type="button" onclick="location.reload()">Try again · Zkusit znovu</button>',
  "</main></body></html>",
].join("");

// =============================================================================
// Build assets
// =============================================================================

async function handleImmutableStaticRequest(request) {
  const cache = await caches.open(STATIC_CACHE_NAME);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && isSameOriginResponse(response)) {
    cache.put(request, response.clone()).catch((error) => {
      console.warn("[SW] Failed to cache static asset", request.url, error);
    });
  }
  return response;
}

async function handleAppAssetRequest(request) {
  const cache = await caches.open(STATIC_CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok && isSameOriginResponse(response)) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return markOffline(cached);
    throw error;
  }
}

// =============================================================================
// JSON data
// =============================================================================

async function handleDataRequest(request) {
  try {
    const response = await fetch(request);
    if (response.ok && isSameOriginResponse(response)) {
      const contentType = response.headers.get("content-type") || "";
      if (isStorableDataResponse(request, contentType)) {
        await storeDataResponse(request, response.clone());
      }
    }
    return response;
  } catch (error) {
    const cached = await matchCached(DATA_CACHE_NAME, request.url);
    if (cached) {
      return markOffline(cached);
    }
    throw error;
  }
}

function isStorableDataResponse(request, contentType) {
  const pathname = new URL(request.url).pathname;
  if (/\/poster$/.test(pathname)) {
    return contentType.startsWith("image/");
  }
  return contentType.includes("application/json");
}

async function storeDataResponse(request, response) {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/auth/get-session") {
    // A signed-out session is "null"; never let it shadow a real one.
    const text = await response.clone().text();
    if (!text || text.trim() === "null") return;
  }
  await storeResponse(DATA_CACHE_NAME, request.url, response);
  dataCacheWrites += 1;
  if (dataCacheWrites % 50 === 0) {
    pruneDataCache().catch(() => {});
  }
}

/** Keep the opportunistic data cache bounded by dropping the oldest entries. */
async function pruneDataCache() {
  const cache = await caches.open(DATA_CACHE_NAME);
  const keys = await cache.keys();
  if (keys.length <= DATA_CACHE_MAX_ENTRIES) return;

  const stamped = [];
  for (const request of keys) {
    const response = await cache.match(request);
    const cachedAt = Number.parseInt(response?.headers.get(CACHED_AT_HEADER) || "0", 10);
    stamped.push({ request, cachedAt: Number.isFinite(cachedAt) ? cachedAt : 0 });
  }
  stamped.sort((a, b) => a.cachedAt - b.cachedAt);
  const excess = stamped.slice(0, stamped.length - DATA_CACHE_MAX_ENTRIES);
  await Promise.all(excess.map((entry) => cache.delete(entry.request)));
}

// =============================================================================
// Audio
// =============================================================================

/**
 * Cache key for an audio URL: only `source` and `variant` change the bytes.
 * Mirrors getAudioCacheKey in src/lib/offline/audio-cache-format.ts.
 */
function getCacheKey(url) {
  const parsed = new URL(url, self.location.origin);
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

function getChunkKey(baseKey, chunkIndex) {
  const separator = baseKey.includes("?") ? "&" : "?";
  return `${baseKey}${separator}_chunk=${chunkIndex}`;
}

function getMetaKey(baseKey) {
  const separator = baseKey.includes("?") ? "&" : "?";
  return `${baseKey}${separator}_meta`;
}

function isAudioCacheEntryFor(baseKey, entryUrl) {
  if (!entryUrl.startsWith(baseKey)) return false;
  const suffix = entryUrl.slice(baseKey.length);
  return (
    suffix === "?_meta" ||
    suffix === "&_meta" ||
    suffix.startsWith("?_chunk=") ||
    suffix.startsWith("&_chunk=")
  );
}

async function deleteAudioCacheEntries(cache, baseKey) {
  try {
    const keys = await cache.keys();
    await Promise.all(
      keys.filter((request) => isAudioCacheEntryFor(baseKey, request.url)).map((request) => cache.delete(request))
    );
  } catch (error) {
    console.error("[SW] Audio cache cleanup failed:", error);
  }
}

async function handleAudioRequest(request) {
  const cache = await caches.open(AUDIO_CACHE_NAME);
  const cacheKey = getCacheKey(request.url);
  const metaResponse = await cache.match(getMetaKey(cacheKey));
  if (!metaResponse) {
    // Not downloaded: let the browser stream from the server as usual.
    return fetch(request);
  }

  let meta;
  try {
    meta = await metaResponse.json();
  } catch {
    await deleteAudioCacheEntries(cache, cacheKey);
    return fetch(request);
  }
  return handleRangeFromChunks(cache, cacheKey, meta, request.headers.get("range"), request);
}

/**
 * Parse an HTTP Range header per RFC 9110 §14.1.2. Supports "bytes=N-M",
 * "bytes=N-", and "bytes=-N" (suffix). Anything else is "invalid" and the
 * caller answers with the full file. Kept in sync with the server route in
 * src/app/api/catalogs/[id]/recordings/[hash]/audio/route.ts.
 */
function parseRangeHeader(rangeHeader, totalSize) {
  if (!rangeHeader) return { kind: "invalid" };
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return { kind: "invalid" };

  const hasStart = match[1] !== "";
  const hasEnd = match[2] !== "";
  if (!hasStart && !hasEnd) return { kind: "invalid" };

  if (!hasStart) {
    const suffixLength = parseInt(match[2], 10);
    if (suffixLength === 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, totalSize - suffixLength);
    return { kind: "range", start, end: totalSize - 1 };
  }

  const start = parseInt(match[1], 10);
  if (start >= totalSize) return { kind: "unsatisfiable" };
  const end = hasEnd ? Math.min(parseInt(match[2], 10), totalSize - 1) : totalSize - 1;
  return { kind: "range", start, end };
}

/**
 * Answer a request from the chunk cache. Only complete caches are served;
 * during a download the request goes to the network so cached and live bytes
 * never mix. Any integrity failure wipes the entry and falls back to network.
 */
async function handleRangeFromChunks(cache, baseKey, meta, rangeHeader, request) {
  const { totalSize, contentType, complete, chunkSizes } = meta;
  if (complete !== true || !Array.isArray(chunkSizes) || chunkSizes.length === 0) {
    return fetch(request);
  }

  const chunkOffsets = [0];
  for (let i = 0; i < chunkSizes.length; i++) {
    chunkOffsets.push(chunkOffsets[i] + chunkSizes[i]);
  }
  const chunkCount = chunkSizes.length;
  const availableBytes = chunkOffsets[chunkCount];

  if (availableBytes !== totalSize) {
    console.error("[SW] Audio cache integrity error: chunk sizes", availableBytes, "!= totalSize", totalSize);
    await deleteAudioCacheEntries(cache, baseKey);
    return fetch(request);
  }

  let start = 0;
  let end = totalSize - 1;
  let isRangeRequest = false;

  if (rangeHeader) {
    const parsed = parseRangeHeader(rangeHeader, totalSize);
    if (parsed.kind === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${totalSize}` },
      });
    }
    if (parsed.kind === "range") {
      start = parsed.start;
      end = parsed.end;
      isRangeRequest = true;
    }
  }

  let startChunk = -1;
  let endChunk = -1;
  for (let i = 0; i < chunkCount; i++) {
    const chunkStart = chunkOffsets[i];
    const chunkEnd = chunkOffsets[i + 1] - 1;
    if (startChunk === -1 && start <= chunkEnd) {
      startChunk = i;
    }
    if (end >= chunkStart && end <= chunkEnd) {
      endChunk = i;
      break;
    }
  }
  if (startChunk === -1 || endChunk === -1) {
    console.error("[SW] Audio cache error: range", start, "-", end, "not covered by chunks");
    await deleteAudioCacheEntries(cache, baseKey);
    return fetch(request);
  }

  const chunks = [];
  for (let i = startChunk; i <= endChunk; i++) {
    const chunkResponse = await cache.match(getChunkKey(baseKey, i));
    if (!chunkResponse) {
      console.error("[SW] Audio cache corrupted: missing chunk", i);
      await deleteAudioCacheEntries(cache, baseKey);
      return fetch(request);
    }
    const chunkData = await chunkResponse.arrayBuffer();
    if (chunkData.byteLength !== chunkSizes[i]) {
      console.error("[SW] Audio chunk", i, "size mismatch:", chunkData.byteLength, "expected", chunkSizes[i]);
      await deleteAudioCacheEntries(cache, baseKey);
      return fetch(request);
    }
    chunks.push(chunkData);
  }

  const combinedSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(combinedSize);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }

  const bufferStart = start - chunkOffsets[startChunk];
  const bufferEnd = bufferStart + (end - start + 1);
  if (bufferStart < 0 || bufferEnd > combinedSize) {
    console.error("[SW] Audio slice out of bounds:", bufferStart, bufferEnd, combinedSize);
    await deleteAudioCacheEntries(cache, baseKey);
    return fetch(request);
  }

  const sliced = combined.slice(bufferStart, bufferEnd);
  return new Response(sliced, {
    status: isRangeRequest ? 206 : 200,
    headers: {
      "Content-Type": contentType || "audio/webm",
      "Content-Length": String(sliced.byteLength),
      ...(isRangeRequest && {
        "Content-Range": `bytes ${start}-${end}/${totalSize}`,
      }),
      "Accept-Ranges": "bytes",
      [OFFLINE_RESPONSE_HEADER]: "1",
    },
  });
}

// Exposed for tests/unit/service-worker-script.test.ts, which checks these
// against src/lib/offline. Not used at runtime.
self.__BESEDY_SW_INTERNALS = {
  AUDIO_CACHE_NAME,
  DATA_CACHE_NAME,
  SHELL_CACHE_NAME,
  STATIC_CACHE_NAME,
  CHUNK_SIZE,
  DOWNLOADS_PATH,
  OFFLINE_RESPONSE_HEADER,
  CACHED_AT_HEADER,
  getCacheKey,
  getChunkKey,
  getMetaKey,
  isAudioCacheEntryFor,
  isCacheableDataPath,
  isShellPath,
  parseRangeHeader,
};

// =============================================================================
// Push notifications
// =============================================================================

self.addEventListener("push", (event) => {
  let data = {
    title: "Besedy",
    body: "New content available",
    icon: "/icon-192.svg",
    badge: "/badge-72.svg",
    tag: "besedy-update",
    data: { url: "/catalog" },
  };

  if (event.data) {
    try {
      const payload = event.data.json();
      data = { ...data, ...payload };
    } catch (e) {
      console.error("[SW] Failed to parse push data:", e);
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || "/icon-192.svg",
    badge: data.badge || "/badge-72.svg",
    tag: data.tag || "besedy-update",
    data: data.data || { url: "/catalog" },
    vibrate: [100, 50, 100],
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

/** Only relative or same-origin URLs may be opened from a notification. */
function isValidNotificationUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("/")) return true;
  try {
    const parsed = new URL(url, self.location.origin);
    return parsed.origin === self.location.origin;
  } catch {
    return false;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const rawUrl = event.notification.data?.url;
  const url = isValidNotificationUrl(rawUrl) ? rawUrl : "/catalog";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
