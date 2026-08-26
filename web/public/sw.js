/**
 * Service Worker for audio caching and network-first app requests (v9)
 *
 * Provides offline playback for cached audio files.
 * Audio is downloaded in chunks (2MB) to be mobile-friendly.
 * Transcript/API JSON responses intentionally stay network-only until the
 * non-audio caching model is redesigned and can be re-enabled safely.
 *
 * v9 changes:
 * - Fixed cacheAudioFile/cacheAudioForContent first fetch to request exactly
 *   one CHUNK_SIZE range instead of the whole file with `bytes=0-`. The old
 *   behavior stored the entire file as chunk 0, making every range request
 *   load the full file into memory and risking OOM on mobile.
 * - Bumped audio cache namespace to invalidate legacy single-chunk caches.
 *
 * v5 changes:
 * - Added network-first handler for navigation requests (HTML pages)
 *   This ensures fresh HTML/JS is always fetched after SW updates,
 *   fixing the mobile issue where users can't hard refresh to bypass
 *   the browser's HTTP cache after clicking the update banner.
 *
 * v8 changes:
 * - Disabled transcript service-worker caching so transcript JSON always
 *   revalidates against the network until the broader cache model is redesigned
 *
 * v7 changes:
 * - Bypass service worker navigation handling for auth/OAuth routes
 *   so callback requests are handled directly by the browser
 *
 * v6 changes:
 * - Updated audio API route matching to catalog-scoped endpoint:
 *   /api/catalogs/:id/recordings/:hash/audio
 * - Bumped audio cache namespace to invalidate stale cache keys from legacy routes
 *
 * v4 changes:
 * - Fixed mobile streaming cookie issue: all network fallback fetches now
 *   explicitly include credentials to ensure auth cookies are sent on
 *   Android Chrome Range requests
 *
 * Cache metadata format (v3) for audio:
 * - totalSize: Total file size in bytes
 * - chunkCount: Number of chunks stored
 * - chunkSizes: Array of actual bytes per chunk (for correct offset calculation)
 * - contentType: MIME type of the audio
 * - complete: true when all chunks downloaded, false during download
 *
 * Integrity checks:
 * - Sum of chunkSizes must equal totalSize when complete
 * - Each chunk's actual size must match recorded size in chunkSizes
 * - Falls back to network fetch on any validation failure
 */

const CACHE_NAME = "besedy-audio-v5";
const AUDIO_URL_PATTERN = /\/api\/catalogs\/[^/]+\/recordings\/([a-f0-9]{64})\/audio/;
const TRANSCRIPT_URL_PATTERN = /\/api\/transcript\/([a-f0-9]{64})/;
const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB (matches server chunk size)
const AUTH_NAVIGATION_PREFIXES = ["/api/auth/", "/mock-oauth/"];

// Track ongoing cache operations to prevent duplicates
const cacheOperations = new Map();

// Install: Wait for user to approve update (via SKIP_WAITING message)
// This allows showing "Update available" toast before reloading
self.addEventListener("install", () => {
  // Don't call skipWaiting() here - wait for user approval
  console.log("[SW] New version installed, waiting for activation");
});

// Activate: Clean old caches and claim clients
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => {
        return Promise.all(
          names
            .filter(
              (name) =>
                (name.startsWith("besedy-audio-") && name !== CACHE_NAME) ||
                name.startsWith("besedy-transcript-")
            )
            .map((name) => caches.delete(name))
        );
      })
      .then(() => self.clients.claim())
  );
});

// =============================================================================
// Push Notifications
// =============================================================================

/**
 * Handle push notification events
 */
self.addEventListener("push", (event) => {
  console.log("[SW] Push received");

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

/**
 * Validate notification URL is safe to open (relative or same-origin)
 */
function isValidNotificationUrl(url) {
  if (!url || typeof url !== "string") return false;

  // Allow relative URLs
  if (url.startsWith("/")) return true;

  // Check same-origin for absolute URLs
  try {
    const parsed = new URL(url, self.location.origin);
    return parsed.origin === self.location.origin;
  } catch {
    return false;
  }
}

/**
 * Handle notification click - open or focus the app
 */
self.addEventListener("notificationclick", (event) => {
  console.log("[SW] Notification clicked");

  event.notification.close();

  const rawUrl = event.notification.data?.url;
  const url = isValidNotificationUrl(rawUrl) ? rawUrl : "/catalog";

  // Focus existing window or open new one
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Find an existing window with the app
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        // Open new window if none exists
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
      })
  );
});

// Fetch: Intercept audio, transcript, and navigation requests
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Debug: log all requests to see what's being intercepted
  if (url.pathname.includes("/api/")) {
    console.log("[SW] Fetch:", event.request.method, url.pathname, "Range:", event.request.headers.get("range"));
  }

  // Intercept audio requests ONLY if cached
  // If not cached, let browser handle directly (fixes ERR_FAILED with streaming)
  if (AUDIO_URL_PATTERN.test(url.pathname)) {
    // Downloads always go direct to server (need Content-Disposition header)
    if (url.searchParams.get("download") === "true") {
      return;
    }

    // Check cache and only intercept if we have it cached
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cacheKey = getCacheKey(event.request.url);
        const metaKey = getMetaKey(cacheKey);

        // Check v2 chunked cache
        const metaResponse = await cache.match(metaKey);
        if (metaResponse) {
          console.log("[SW] Audio cached (v2), serving from cache");
          return handleAudioRequest(event.request);
        }

        // Check v1 single-blob cache
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          console.log("[SW] Audio cached (v1), serving from cache");
          return cachedResponse.clone();
        }

        // NOT cached - pass through without credentials override
        // The browser's native request handling will include cookies for same-origin
        // Adding { credentials: "include" } caused ERR_FAILED on some browsers
        console.log("[SW] Audio not cached, passing through");
        return fetch(event.request);
      })()
    );
    return;
  }

  // Intercept transcript API requests
  if (TRANSCRIPT_URL_PATTERN.test(url.pathname)) {
    event.respondWith(handleTranscriptRequest(event.request));
    return;
  }

  // Handle navigation requests (HTML pages) - network-first for fresh content
  // This ensures users always get fresh HTML/JS after SW updates, fixing mobile
  // where users can't do a hard refresh to bypass HTTP cache.
  // See: https://web.dev/articles/handling-navigation-requests
  if (event.request.mode === "navigate") {
    if (AUTH_NAVIGATION_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      console.log("[SW] Bypassing auth navigation:", url.pathname);
      return;
    }

    console.log("[SW] Intercepting navigation:", event.request.url);
    event.respondWith(
      fetch(event.request, {
        credentials: "include",
        cache: "no-store", // Bypass HTTP cache to ensure fresh HTML/JS
      })
        .then((response) => {
          console.log("[SW] Navigation fetched from network:", response.status);
          return response;
        })
        .catch((error) => {
          console.log("[SW] Navigation fetch failed:", error.message);
          // Offline fallback - return a simple offline page
          return new Response(
            "<!DOCTYPE html><html><head><title>Offline</title></head>" +
              "<body><h1>You're offline</h1><p>Please check your connection.</p></body></html>",
            {
              status: 503,
              headers: { "Content-Type": "text/html" },
            }
          );
        })
    );
    return;
  }
});

/**
 * Handle audio requests - serve from cache if available
 */
async function handleAudioRequest(request) {
  const url = new URL(request.url);

  // Never serve downloads from cache - they need Content-Disposition header from server
  if (url.searchParams.get("download") === "true") {
    console.log("[SW] Download request, bypassing cache");
    return fetch(request);
  }

  const cache = await caches.open(CACHE_NAME);
  const cacheKey = getCacheKey(request.url);
  const metaKey = getMetaKey(cacheKey);

  // Check for chunked cache (v2 format)
  const metaResponse = await cache.match(metaKey);
  if (metaResponse) {
    const meta = await metaResponse.json();
    const rangeHeader = request.headers.get("range");
    return handleRangeFromChunks(cache, cacheKey, meta, rangeHeader, request);
  }

  // Fallback: check old single-blob format (v1 migration)
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    console.log("[SW] Serving from v1 cache (single blob)");
    const rangeHeader = request.headers.get("range");
    if (rangeHeader) {
      return handleRangeFromCache(cachedResponse, rangeHeader);
    }
    return cachedResponse.clone();
  }

  // Not cached - let browser handle normally (streaming with Range)
  console.log("[SW] Not cached, fetching from network");
  return fetch(request);
}

/**
 * Get cache key - include source/variant for correct audio variant matching
 * Different sources (archived, listening) and variants are cached separately
 */
function getCacheKey(url) {
  if (!url) return null;
  // Handle relative URLs by using SW's origin as base
  const parsed = new URL(url, self.location.origin);

  // Extract cache-relevant params (source and variant affect audio content)
  const source = parsed.searchParams.get("source") || "archived";
  const variant = parsed.searchParams.get("variant") || "";

  // Clear all params, add back only cache-relevant ones
  parsed.search = "";

  // Only add source if not the default (archived)
  if (source !== "archived") {
    parsed.searchParams.set("source", source);
  }
  // Add variant if present
  if (variant) {
    parsed.searchParams.set("variant", variant);
  }

  return parsed.toString();
}

/**
 * Get chunk cache key
 */
function getChunkKey(baseKey, chunkIndex) {
  const separator = baseKey.includes("?") ? "&" : "?";
  return `${baseKey}${separator}_chunk=${chunkIndex}`;
}

/**
 * Get metadata cache key
 */
function getMetaKey(baseKey) {
  const separator = baseKey.includes("?") ? "&" : "?";
  return `${baseKey}${separator}_meta`;
}

/**
 * Handle Range request from chunked cache
 * Loads only the chunks needed to satisfy the range request
 *
 * Only serves from cache when download is complete. During download,
 * falls back to network to prevent mixing cached and network data
 * which causes format errors. The audio element is reloaded when
 * caching completes to switch to cached playback consistently.
 *
 * Uses actual stored chunk sizes (from metadata) for correct offset calculation.
 * Falls back to network if chunk validation fails.
 */

/**
 * Parse an HTTP Range header per RFC 9110 §14.1.2 and return a structured
 * result. Supports:
 *   - "bytes=N-M"  normal range
 *   - "bytes=N-"   open-ended from N to end of resource
 *   - "bytes=-N"   suffix: last N bytes (clamped to whole resource if N > size)
 * Anything else (including "bytes=-" with no numbers) is treated as invalid;
 * callers decide whether to fall back to a 200 full-file response.
 *
 * Kept in sync with the server route at
 * web/src/app/api/catalogs/[id]/recordings/[hash]/audio/route.ts so cached
 * and network-served playback behave identically.
 */
function parseRangeHeader(rangeHeader, totalSize) {
  if (!rangeHeader) return { kind: "invalid" };
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return { kind: "invalid" };

  const hasStart = match[1] !== "";
  const hasEnd = match[2] !== "";
  if (!hasStart && !hasEnd) return { kind: "invalid" };

  if (!hasStart) {
    // Suffix range: last N bytes.
    const suffixLength = parseInt(match[2], 10);
    if (suffixLength === 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, totalSize - suffixLength);
    return { kind: "range", start, end: totalSize - 1 };
  }

  const start = parseInt(match[1], 10);
  if (start >= totalSize) return { kind: "unsatisfiable" };
  const end = hasEnd
    ? Math.min(parseInt(match[2], 10), totalSize - 1)
    : totalSize - 1;
  return { kind: "range", start, end };
}

async function handleRangeFromChunks(cache, baseKey, meta, rangeHeader, request) {
  const { totalSize, contentType, complete, chunkSizes } = meta;
  const isComplete = complete !== false;

  // Check for v3 format with chunkSizes array
  const hasChunkSizes = Array.isArray(chunkSizes) && chunkSizes.length > 0;

  // Build chunk offset map from actual stored sizes (v3) or estimate from CHUNK_SIZE (v2 fallback)
  // chunkOffsets[i] = byte offset where chunk i starts
  const chunkOffsets = [0];
  if (hasChunkSizes) {
    for (let i = 0; i < chunkSizes.length; i++) {
      chunkOffsets.push(chunkOffsets[i] + chunkSizes[i]);
    }
  } else {
    // v2 fallback: estimate using fixed CHUNK_SIZE
    const estimatedChunks = Math.ceil(totalSize / CHUNK_SIZE);
    for (let i = 0; i < estimatedChunks; i++) {
      const chunkEnd = Math.min((i + 1) * CHUNK_SIZE, totalSize);
      chunkOffsets.push(chunkEnd);
    }
  }

  const chunkCount = chunkOffsets.length - 1;
  const availableBytes = chunkOffsets[chunkOffsets.length - 1];

  // Integrity check: verify total size matches for complete cache.
  // On mismatch, wipe the cache so the next request re-populates cleanly;
  // otherwise every subsequent request falls back to the network while the
  // UI still reports the file as "cached".
  if (isComplete && hasChunkSizes && availableBytes !== totalSize) {
    console.error(
      "[SW] Cache integrity error: chunk sizes sum to",
      availableBytes,
      "but totalSize is",
      totalSize,
      "- clearing cache and falling back to network"
    );
    await cleanupPartialCache(cache, baseKey);
    return fetch(request);
  }

  // Default to full file if no range
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
    // parsed.kind === "invalid": fall through to full-file 200.
  }

  // If cache is incomplete, always fall back to network
  // This prevents mixing cached and network data which causes format errors
  // Once caching completes, the audio element will be reloaded to use cache consistently
  if (!isComplete) {
    console.log("[SW] Cache incomplete, falling back to network for consistent playback");
    return fetch(request);
  }

  console.log("[SW] Serving from complete cache:", {
    totalSize,
    chunkCount,
    availableBytes,
    contentType,
    rangeHeader,
    hasChunkSizes,
  });

  // Find which chunks contain the requested byte range using actual offsets
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

  // Handle edge case: end is at or beyond last byte
  if (endChunk === -1 && end >= chunkOffsets[chunkCount - 1]) {
    endChunk = chunkCount - 1;
  }

  // Check if requested range is beyond cached chunks (shouldn't happen for complete cache)
  if (startChunk === -1 || endChunk === -1) {
    console.error(
      "[SW] Cache error: requested range",
      start,
      "-",
      end,
      "not covered by chunks - clearing cache and falling back to network"
    );
    await cleanupPartialCache(cache, baseKey);
    return fetch(request);
  }

  // Load and validate needed chunks
  const chunks = [];
  for (let i = startChunk; i <= endChunk; i++) {
    const chunkKey = getChunkKey(baseKey, i);
    const chunkResponse = await cache.match(chunkKey);

    if (!chunkResponse) {
      console.error("[SW] Cache corrupted: missing chunk", i, "- clearing cache and falling back to network");
      await cleanupPartialCache(cache, baseKey);
      return fetch(request);
    }

    const chunkData = await chunkResponse.arrayBuffer();

    // Validate chunk size matches recorded size (v3 format only)
    if (hasChunkSizes) {
      const expectedSize = chunkSizes[i];
      if (chunkData.byteLength !== expectedSize) {
        console.error(
          "[SW] Chunk",
          i,
          "size mismatch: got",
          chunkData.byteLength,
          "expected",
          expectedSize,
          "- clearing cache and falling back to network"
        );
        await cleanupPartialCache(cache, baseKey);
        return fetch(request);
      }
    }

    chunks.push(chunkData);
  }

  // Combine chunks
  const combinedSize = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const combinedBuffer = new Uint8Array(combinedSize);
  let offset = 0;
  for (const chunk of chunks) {
    combinedBuffer.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }

  // Calculate slice offsets within combined buffer using actual chunk boundaries
  const bufferStart = start - chunkOffsets[startChunk];
  const bufferEnd = bufferStart + (end - start + 1);

  // Final validation: ensure slice is within bounds
  if (bufferStart < 0 || bufferEnd > combinedSize) {
    console.error(
      "[SW] Slice bounds error: bufferStart=",
      bufferStart,
      "bufferEnd=",
      bufferEnd,
      "combinedSize=",
      combinedSize,
      "- clearing cache and falling back to network"
    );
    await cleanupPartialCache(cache, baseKey);
    return fetch(request);
  }

  const sliced = combinedBuffer.slice(bufferStart, bufferEnd);

  console.log("[SW] Serving from cache:", {
    requestedRange: `${start}-${end}`,
    chunks: `${startChunk}-${endChunk}`,
    combinedSize,
    slicedSize: sliced.byteLength,
    expectedSize: end - start + 1,
    isRangeRequest,
    status: isRangeRequest ? 206 : 200,
    contentType,
  });

  // Verify sliced size matches expected
  if (sliced.byteLength !== end - start + 1) {
    console.error(
      "[SW] Sliced size mismatch!",
      sliced.byteLength,
      "vs expected",
      end - start + 1,
      "- clearing cache and falling back to network"
    );
    await cleanupPartialCache(cache, baseKey);
    return fetch(request);
  }

  return new Response(sliced, {
    status: isRangeRequest ? 206 : 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(sliced.byteLength),
      ...(isRangeRequest && {
        "Content-Range": `bytes ${start}-${end}/${totalSize}`,
      }),
      "Accept-Ranges": "bytes",
    },
  });
}

/**
 * Handle Range request from cached full file (v1 format)
 * Reconstructs 206 Partial Content response from cached blob
 */
async function handleRangeFromCache(response, rangeHeader) {
  // Clone the response before reading - response body can only be read once
  const clonedResponse = response.clone();
  const blob = await clonedResponse.blob();
  const totalSize = blob.size;

  console.log("[SW] Range request (v1):", rangeHeader, "totalSize:", totalSize);

  const parsed = parseRangeHeader(rangeHeader, totalSize);
  if (parsed.kind === "invalid") {
    console.log("[SW] Invalid range header, returning full response");
    return response.clone();
  }
  if (parsed.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${totalSize}` },
    });
  }

  const { start, end } = parsed;
  const slicedBlob = blob.slice(start, end + 1);

  console.log("[SW] Serving range:", start, "-", end, "size:", slicedBlob.size);

  return new Response(slicedBlob, {
    status: 206,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "audio/webm",
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${totalSize}`,
      "Accept-Ranges": "bytes",
    },
  });
}

// Single message handler for all client-to-SW messages.
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
      console.log("[SW] Received SKIP_WAITING, activating new version");
      self.skipWaiting();
      return;

    // Legacy audio-only operations
    case "CACHE_AUDIO":
      cacheAudioFile(data.url, data.hash, event.source);
      return;
    case "CHECK_CACHE":
      checkCacheStatus(data.url, data.hash, event.source);
      return;
    case "CLEAR_CACHE":
      clearAudioCache(data.hash, event.source);
      return;

    // Content operations (audio only)
    case "CACHE_CONTENT":
      cacheContent(
        data.hash,
        data.audioUrl,
        data.catalogId,
        data.transcriptBackend,
        data.speakersBackend,
        event.source
      );
      return;
    case "CHECK_CONTENT_CACHE":
      checkContentCacheStatus(data.hash, data.catalogId, event.source);
      return;
    case "CLEAR_CONTENT_CACHE":
      clearContentCache(data.hash, event.source);
      return;

    default:
      console.warn("[SW] Unknown message type:", data.type);
      return;
  }
});

/**
 * Cache audio file by downloading in chunks
 * Mobile-friendly: reports progress per chunk, stores each chunk separately
 */
async function cacheAudioFile(url, hash, client) {
  // Validate URL
  if (!url) {
    client.postMessage({
      type: "CACHE_ERROR",
      hash,
      error: "Invalid URL",
    });
    return;
  }

  // Prevent duplicate operations AND back off if a cleanup is holding the
  // lock for this hash — putting chunks while cleanup is deleting them
  // produces a mixed-generation cache that still posts CACHE_COMPLETE.
  if (cacheOperations.has(hash) || hasActiveCleanup(hash)) {
    return;
  }
  cacheOperations.set(hash, true);

  const cache = await caches.open(CACHE_NAME);
  const cacheKey = getCacheKey(url);

  try {
    // First request: fetch only the first chunk (keeps mobile memory bounded).
    // An open-ended `bytes=0-` would pull the whole file in one response.
    const firstResponse = await fetch(url, {
      credentials: "include",
      headers: {
        Range: `bytes=0-${CHUNK_SIZE - 1}`,
      },
    });

    if (!firstResponse.ok && firstResponse.status !== 206) {
      throw new Error(`HTTP ${firstResponse.status}`);
    }

    // Parse Content-Range to get total size: "bytes 0-X/TOTAL"
    const contentRange = firstResponse.headers.get("Content-Range");
    let totalSize = 0;

    if (contentRange) {
      const match = contentRange.match(/\/(\d+)$/);
      if (match) {
        totalSize = parseInt(match[1], 10);
      }
    }

    if (!totalSize) {
      // Fallback: use Content-Length if no range (shouldn't happen)
      totalSize = parseInt(
        firstResponse.headers.get("Content-Length") || "0",
        10
      );
    }

    const contentType =
      firstResponse.headers.get("Content-Type") || "audio/webm";

    const firstChunk = await firstResponse.arrayBuffer();

    const expectedFirstChunkSize = Math.min(CHUNK_SIZE, totalSize);
    if (firstChunk.byteLength !== expectedFirstChunkSize) {
      console.warn(
        "[SW] First chunk size mismatch:",
        firstChunk.byteLength,
        "expected:",
        expectedFirstChunkSize
      );
    }

    // Store first chunk
    await cache.put(
      getChunkKey(cacheKey, 0),
      new Response(firstChunk, {
        headers: { "Content-Type": "application/octet-stream" },
      })
    );

    let bytesLoaded = firstChunk.byteLength;
    let chunkIndex = 1;

    // Track actual chunk sizes for integrity validation (v3 format)
    const chunkSizes = [firstChunk.byteLength];

    // Write initial metadata immediately so playback can use first chunk.
    // If the file fit entirely in the first chunk, the cache is already complete.
    await cache.put(
      getMetaKey(cacheKey),
      new Response(
        JSON.stringify({
          totalSize,
          chunkCount: 1,
          chunkSizes,
          contentType,
          complete: bytesLoaded >= totalSize,
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );

    reportProgress(client, hash, bytesLoaded, totalSize);

    // Download and store remaining chunks
    while (bytesLoaded < totalSize) {
      const start = bytesLoaded;
      const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);

      const chunkResponse = await fetch(url, {
        credentials: "include",
        headers: {
          Range: `bytes=${start}-${end}`,
        },
      });

      if (!chunkResponse.ok && chunkResponse.status !== 206) {
        throw new Error(`Chunk fetch failed: HTTP ${chunkResponse.status}`);
      }

      const chunk = await chunkResponse.arrayBuffer();

      // Store chunk immediately
      await cache.put(
        getChunkKey(cacheKey, chunkIndex),
        new Response(chunk, {
          headers: { "Content-Type": "application/octet-stream" },
        })
      );

      bytesLoaded += chunk.byteLength;
      chunkSizes.push(chunk.byteLength);
      chunkIndex++;

      // Update metadata progressively so playback can use downloaded chunks
      const isComplete = bytesLoaded >= totalSize;
      await cache.put(
        getMetaKey(cacheKey),
        new Response(
          JSON.stringify({
            totalSize,
            chunkCount: chunkIndex,
            chunkSizes,
            contentType,
            complete: isComplete,
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );

      reportProgress(client, hash, bytesLoaded, totalSize);
    }

    client.postMessage({
      type: "CACHE_COMPLETE",
      hash,
    });
  } catch (error) {
    // On error, clean up partial chunks for this specific cache key
    await cleanupPartialCache(cache, cacheKey);
    client.postMessage({
      type: "CACHE_ERROR",
      hash,
      error: error.message,
    });
  } finally {
    cacheOperations.delete(hash);
  }
}

/**
 * Extract the audio hash from a cache key (whose URL always ends
 * `/recordings/<hash>/audio` per AUDIO_URL_PATTERN). Returns null for
 * non-audio keys, in which case the caller should skip the concurrency guard.
 */
function hashFromAudioKey(baseKey) {
  if (!baseKey) return null;
  const match = baseKey.match(/\/recordings\/([a-f0-9]{64})\/audio/);
  return match ? match[1] : null;
}

/**
 * cacheOperations key families:
 *   - `<hash>`            — cacheAudioFile in progress
 *   - `content-<hash>`    — cacheContent/cacheAudioForContent in progress
 *   - `cleanup-<hash>`    — cleanupPartialCache delete loop holding the lock
 *
 * Any writer or cleanup acts as a mutex against the others for the same hash.
 */
function cacheWriterKeys(hash) {
  return [hash, `content-${hash}`];
}
function cleanupLockKey(hash) {
  return `cleanup-${hash}`;
}
function hasActiveCacheWriter(hash) {
  if (!hash) return false;
  return cacheOperations.has(hash) || cacheOperations.has(`content-${hash}`);
}
function hasActiveCleanup(hash) {
  if (!hash) return false;
  return cacheOperations.has(cleanupLockKey(hash));
}

/**
 * Clean up partial cache entries after failed download.
 *
 * Correctness against concurrent writers:
 *  1. Before the delete loop begins, we check `hasActiveCacheWriter` AND
 *     acquire the `cleanup-<hash>` lock in a single synchronous step — no
 *     await, so no interleaving can happen between check and set.
 *  2. Writers (`cacheAudioFile`, `cacheContent`/`cacheAudioForContent`)
 *     check the cleanup lock synchronously at start and back off.
 *  3. We hold the lock across the entire await-laden delete loop and
 *     release it in `finally`.
 * Together these close the TOCTOU window the earlier single-check guard
 * left open — a writer that started after the check but before the delete
 * loop finished could previously still race.
 */
async function cleanupPartialCache(cache, baseKey) {
  const hash = hashFromAudioKey(baseKey);
  // Synchronous atomic check + lock-acquire. No await between these two
  // statements means no interleaving writer can sneak in.
  if (hash) {
    if (hasActiveCacheWriter(hash) || hasActiveCleanup(hash)) {
      console.log(
        "[SW] Skipping cleanup for",
        baseKey,
        "— concurrent writer or cleanup active for hash",
        hash
      );
      return;
    }
    cacheOperations.set(cleanupLockKey(hash), true);
  }
  try {
    const keys = await cache.keys();

    for (const request of keys) {
      const url = request.url;
      // Only delete entries that:
      // 1. Are the exact baseKey (shouldn't exist without meta, but clean up)
      // 2. Start with baseKey and have _chunk= or _meta suffix
      if (url === baseKey) {
        await cache.delete(request);
      } else if (url.startsWith(baseKey)) {
        // Check it's actually a chunk/meta key, not a different variant
        const suffix = url.slice(baseKey.length);
        if (
          suffix.startsWith("?_chunk=") ||
          suffix.startsWith("&_chunk=") ||
          suffix.startsWith("?_meta") ||
          suffix.startsWith("&_meta")
        ) {
          await cache.delete(request);
        }
      }
    }
  } catch (e) {
    console.error("[SW] Cleanup failed:", e);
  } finally {
    if (hash) {
      cacheOperations.delete(cleanupLockKey(hash));
    }
  }
}

/**
 * Report download progress to client
 */
function reportProgress(client, hash, bytesLoaded, totalBytes) {
  const progress =
    totalBytes > 0 ? Math.round((bytesLoaded / totalBytes) * 100) : 0;

  client.postMessage({
    type: "CACHE_PROGRESS",
    hash,
    progress,
    bytesLoaded,
    totalBytes,
  });
}

/**
 * Check if audio is cached
 */
async function checkCacheStatus(url, hash, client) {
  const cacheKey = getCacheKey(url);
  if (!cacheKey) {
    client.postMessage({
      type: "CACHE_STATUS",
      hash,
      isCached: false,
    });
    return;
  }

  const cache = await caches.open(CACHE_NAME);

  // Check for chunked format (v2/v3)
  const metaResponse = await cache.match(getMetaKey(cacheKey));
  if (metaResponse) {
    const meta = await metaResponse.json();
    // Report complete vs partial cache status
    // complete: true means all chunks downloaded, false means download in progress
    const isComplete = meta.complete !== false; // Default to true for legacy metadata without complete flag

    // Calculate bytes loaded from actual chunk sizes (v3) or estimate (v2 fallback)
    let bytesLoaded;
    if (Array.isArray(meta.chunkSizes) && meta.chunkSizes.length > 0) {
      bytesLoaded = meta.chunkSizes.reduce((sum, size) => sum + size, 0);
    } else {
      // v2 fallback: estimate using fixed CHUNK_SIZE
      bytesLoaded = meta.chunkCount * CHUNK_SIZE;
    }

    client.postMessage({
      type: "CACHE_STATUS",
      hash,
      isCached: true,
      isComplete,
      size: meta.totalSize,
      chunkCount: meta.chunkCount,
      progress: isComplete ? 100 : Math.min(99, Math.round((bytesLoaded / meta.totalSize) * 100)),
    });
    return;
  }

  // Fallback: check old format (v1)
  const response = await cache.match(cacheKey);
  client.postMessage({
    type: "CACHE_STATUS",
    hash,
    isCached: !!response,
    size: response
      ? parseInt(response.headers.get("Content-Length") || "0", 10)
      : undefined,
  });
}

/**
 * Clear cached audio for a specific hash
 */
async function clearAudioCache(hash, client) {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();

  // Find and delete all entries matching this hash
  // This catches: baseUrl, baseUrl?_meta, baseUrl?_chunk=N, and variants
  for (const request of keys) {
    if (request.url.includes(hash)) {
      await cache.delete(request);
    }
  }

  client.postMessage({
    type: "CACHE_STATUS",
    hash,
    isCached: false,
  });
}

// =============================================================================
// Transcript and Content Caching
// =============================================================================

/**
 * Handle transcript requests - network only for now.
 * Do not reintroduce transcript SW caching until non-audio caching is redesigned.
 */
async function handleTranscriptRequest(request) {
  try {
    const response = await fetch(request, {
      credentials: "include",
      cache: "no-store",
    });
    return response;
  } catch (error) {
    // Offline transcript fallback is intentionally disabled with caching.
    console.log("[SW] Transcript network request failed");
    return new Response(
      JSON.stringify({ error: "Transcript not available offline" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * Cache content (audio only)
 * Transcripts are fetched on-demand and not cached via this flow.
 */
async function cacheContent(hash, audioUrl, catalogId, transcriptBackend, speakersBackend, client) {
  // Note: transcriptBackend and speakersBackend params kept for message compatibility but unused
  void transcriptBackend;
  void speakersBackend;
  void catalogId;

  // Prevent duplicate operations AND back off if a cleanup is holding the
  // lock for this hash — putting chunks while cleanup is deleting them
  // produces a mixed-generation cache that still posts CONTENT_CACHE_COMPLETE.
  const operationKey = `content-${hash}`;
  if (cacheOperations.has(operationKey) || hasActiveCleanup(hash)) {
    return;
  }
  cacheOperations.set(operationKey, true);

  let audioSize = 0;

  try {
    // Cache audio only
    await cacheAudioForContent(audioUrl, hash, (progress, bytes, total) => {
      audioSize = total;
      // Report progress (transcriptProgress always 0 since we don't cache transcripts)
      client.postMessage({
        type: "CONTENT_CACHE_PROGRESS",
        hash,
        progress,
        audioProgress: progress,
        transcriptProgress: 0,
        bytesLoaded: bytes,
        totalBytes: total,
      });
    });

    // Report completion
    client.postMessage({
      type: "CONTENT_CACHE_COMPLETE",
      hash,
      audioSize,
      transcriptSize: 0,
    });
  } catch (error) {
    client.postMessage({
      type: "CONTENT_CACHE_ERROR",
      hash,
      error: error.message,
      failedPart: "audio",
    });
  } finally {
    cacheOperations.delete(operationKey);
  }
}

/**
 * Cache audio file for content caching with progress callback
 */
async function cacheAudioForContent(url, hash, onProgress) {
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = getCacheKey(url);

  // First request: fetch only the first chunk (keeps mobile memory bounded).
  const firstResponse = await fetch(url, {
    credentials: "include",
    headers: { Range: `bytes=0-${CHUNK_SIZE - 1}` },
  });

  if (!firstResponse.ok && firstResponse.status !== 206) {
    throw new Error(`HTTP ${firstResponse.status}`);
  }

  // Parse Content-Range to get total size
  const contentRange = firstResponse.headers.get("Content-Range");
  let totalSize = 0;
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)$/);
    if (match) {
      totalSize = parseInt(match[1], 10);
    }
  }
  if (!totalSize) {
    totalSize = parseInt(firstResponse.headers.get("Content-Length") || "0", 10);
  }

  const contentType = firstResponse.headers.get("Content-Type") || "audio/webm";
  const firstChunk = await firstResponse.arrayBuffer();

  // Store first chunk
  await cache.put(
    getChunkKey(cacheKey, 0),
    new Response(firstChunk, {
      headers: { "Content-Type": "application/octet-stream" },
    })
  );

  let bytesLoaded = firstChunk.byteLength;
  let chunkIndex = 1;
  const chunkSizes = [firstChunk.byteLength];

  // Write initial metadata. If the file fit in a single chunk, the cache is already complete.
  await cache.put(
    getMetaKey(cacheKey),
    new Response(
      JSON.stringify({
        totalSize,
        chunkCount: 1,
        chunkSizes,
        contentType,
        complete: bytesLoaded >= totalSize,
      }),
      { headers: { "Content-Type": "application/json" } }
    )
  );

  onProgress(Math.round((bytesLoaded / totalSize) * 100), bytesLoaded, totalSize);

  // Download remaining chunks
  while (bytesLoaded < totalSize) {
    const start = bytesLoaded;
    const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);

    const chunkResponse = await fetch(url, {
      credentials: "include",
      headers: { Range: `bytes=${start}-${end}` },
    });

    if (!chunkResponse.ok && chunkResponse.status !== 206) {
      throw new Error(`Chunk fetch failed: HTTP ${chunkResponse.status}`);
    }

    const chunk = await chunkResponse.arrayBuffer();
    await cache.put(
      getChunkKey(cacheKey, chunkIndex),
      new Response(chunk, {
        headers: { "Content-Type": "application/octet-stream" },
      })
    );

    bytesLoaded += chunk.byteLength;
    chunkSizes.push(chunk.byteLength);
    chunkIndex++;

    const isComplete = bytesLoaded >= totalSize;
    await cache.put(
      getMetaKey(cacheKey),
      new Response(
        JSON.stringify({ totalSize, chunkCount: chunkIndex, chunkSizes, contentType, complete: isComplete }),
        { headers: { "Content-Type": "application/json" } }
      )
    );

    onProgress(Math.round((bytesLoaded / totalSize) * 100), bytesLoaded, totalSize);
  }
}

/**
 * Check content cache status (audio only)
 * Transcripts are not cached via content cache flow.
 */
async function checkContentCacheStatus(hash, catalogId, client) {
  void catalogId; // Unused but kept for message compatibility

  const audioCache = await caches.open(CACHE_NAME);

  // Check audio cache
  let audioCached = false;
  let audioComplete = false;
  let audioSize = 0;
  let audioProgress = 0;

  // Look for audio metadata - hash is in the path, so includes() is fine here
  const keys = await audioCache.keys();
  for (const request of keys) {
    if (request.url.includes(hash) && request.url.includes("_meta")) {
      const metaResponse = await audioCache.match(request);
      if (metaResponse) {
        const meta = await metaResponse.json();
        audioCached = true;
        audioSize = meta.totalSize;
        if (Array.isArray(meta.chunkSizes)) {
          const loaded = meta.chunkSizes.reduce((s, c) => s + c, 0);
          // Consider complete if all bytes are loaded OR the complete flag is set
          audioComplete = meta.complete !== false || loaded >= meta.totalSize;
          audioProgress = audioComplete ? 100 : Math.round((loaded / meta.totalSize) * 100);
        } else {
          // No chunk sizes - fall back to complete flag
          audioComplete = meta.complete !== false;
        }
      }
      break;
    }
  }

  // Complete = audio is fully cached (transcripts not included)
  const isComplete = audioCached && audioComplete;

  client.postMessage({
    type: "CONTENT_CACHE_STATUS",
    hash,
    audioCached,
    audioComplete,
    audioSize,
    audioProgress,
    transcriptCached: false,
    transcriptBackend: null,
    speakersCached: false,
    isComplete,
  });
}

/**
 * Clear all cached content for a hash (audio + any legacy transcript leftovers)
 * Note: Using includes(hash) is correct here since the 64-char hash appears
 * in the URL path (/api/catalogs/[id]/recordings/[hash]/audio, /api/transcript/[hash])
 * and we want to clear all variants regardless of query params.
 */
async function clearContentCache(hash, client) {
  // Clear audio cache - hash is in path, includes() is correct
  const audioCache = await caches.open(CACHE_NAME);
  const audioKeys = await audioCache.keys();
  for (const request of audioKeys) {
    if (request.url.includes(hash)) {
      await audioCache.delete(request);
    }
  }

  // Clean up any legacy transcript caches left by older service workers.
  const cacheNames = await caches.keys();
  for (const cacheName of cacheNames) {
    if (!cacheName.startsWith("besedy-transcript-")) {
      continue;
    }
    const transcriptCache = await caches.open(cacheName);
    const transcriptKeys = await transcriptCache.keys();
    for (const request of transcriptKeys) {
      if (request.url.includes(hash)) {
        await transcriptCache.delete(request);
      }
    }
  }

  client.postMessage({
    type: "CONTENT_CACHE_STATUS",
    hash,
    audioCached: false,
    audioComplete: false,
    transcriptCached: false,
    speakersCached: false,
    isComplete: false,
  });
}
