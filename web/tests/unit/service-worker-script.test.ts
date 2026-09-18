import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_CHUNK_SIZE,
  getAudioCacheKey,
  getAudioChunkKey,
  getAudioMetaKey,
} from "@/lib/offline/audio-cache-format";
import {
  buildAudioSourcePreferenceUrl,
  buildAudioSourcesUrl,
  buildDiarizationUrl,
  buildEventDetailUrl,
  buildEventPosterUrl,
  buildPlaybackProgressUrl,
  buildRecordingEntryUrl,
  buildTranscriptBackendsUrl,
  buildTranscriptFormatsUrl,
  buildTranscriptUrl,
} from "@/lib/api/recording-urls";
import {
  CACHED_AT_HEADER,
  DOWNLOADS_PATH,
  OFFLINE_CACHE_NAMES,
  OFFLINE_RESPONSE_HEADER,
} from "@/lib/offline/cache-names";

const ORIGIN = "https://besedy.test";
const HASH = "a".repeat(64);

type FetchHandlerEvent = {
  request: Request;
  respondWith: ReturnType<typeof vi.fn>;
};

type RangeParseResult =
  | { kind: "invalid" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; start: number; end: number };

interface SwInternals {
  AUDIO_CACHE_NAME: string;
  DATA_CACHE_NAME: string;
  SHELL_CACHE_NAME: string;
  STATIC_CACHE_NAME: string;
  CHUNK_SIZE: number;
  DOWNLOADS_PATH: string;
  OFFLINE_RESPONSE_HEADER: string;
  CACHED_AT_HEADER: string;
  getCacheKey: (url: string) => string;
  getChunkKey: (baseKey: string, index: number) => string;
  getMetaKey: (baseKey: string) => string;
  isAudioCacheEntryFor: (baseKey: string, entryUrl: string) => boolean;
  isCacheableDataPath: (pathname: string) => boolean;
  isShellPath: (pathname: string) => boolean;
  parseRangeHeader: (rangeHeader: string | null, totalSize: number) => RangeParseResult;
}

/** Minimal in-memory Cache Storage so the worker's cache logic can run in Node. */
class MemoryCache {
  store = new Map<string, Response>();

  private key(request: RequestInfo | URL): string {
    if (typeof request === "string") return new URL(request, ORIGIN).toString();
    if (request instanceof URL) return request.toString();
    return request.url;
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const hit = this.store.get(this.key(request));
    return hit ? hit.clone() : undefined;
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.store.set(this.key(request), response);
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.store.delete(this.key(request));
  }

  async keys(): Promise<Request[]> {
    return Array.from(this.store.keys()).map((url) => new Request(url));
  }
}

class MemoryCacheStorage {
  caches = new Map<string, MemoryCache>();

  async open(name: string): Promise<MemoryCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.caches.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return Array.from(this.caches.keys());
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

function loadScript() {
  const listeners = new Map<string, (event: unknown) => void>();
  const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
  const cacheStorage = new MemoryCacheStorage();
  const consoleMock = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const selfScope: Record<string, unknown> = {
    __BESEDY_WEB_VERSION: "web-v2-test",
    addEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
      listeners.set(type, handler);
    }),
    clients: { claim: vi.fn(), matchAll: vi.fn(), openWindow: vi.fn() },
    location: { origin: ORIGIN },
    registration: { showNotification: vi.fn() },
    skipWaiting: vi.fn(),
  };

  const script = fs.readFileSync(path.resolve(process.cwd(), "public/sw.js"), "utf8");
  const sandbox: Record<string, unknown> = {
    Map,
    Promise,
    Response,
    Request,
    Headers,
    URL,
    Uint8Array,
    Number,
    caches: cacheStorage,
    clients: selfScope.clients,
    console: consoleMock,
    fetch: fetchMock,
    self: selfScope,
  };
  vm.runInNewContext(script, sandbox);

  const fetchHandler = listeners.get("fetch") as ((event: FetchHandlerEvent) => void) | undefined;
  if (!fetchHandler) {
    throw new Error("Failed to register service worker fetch handler");
  }

  return {
    fetchHandler,
    messageHandler: listeners.get("message") as (event: {
      data: unknown;
      ports: Array<{ postMessage: (message: unknown) => void }>;
    }) => void,
    internals: selfScope.__BESEDY_SW_INTERNALS as SwInternals,
    cacheStorage,
    consoleMock,
    fetchMock,
  };
}

function createEvent(url: string, init: RequestInit & { mode?: RequestMode } = {}): FetchHandlerEvent {
  const { mode, ...requestInit } = init;
  const request = new Request(new URL(url, ORIGIN).toString(), requestInit);
  if (mode === "navigate") {
    // Request constructors reject mode "navigate"; expose it via a property instead.
    Object.defineProperty(request, "mode", { value: "navigate" });
  }
  return { request, respondWith: vi.fn() };
}

async function respondedWith(event: FetchHandlerEvent): Promise<Response> {
  expect(event.respondWith).toHaveBeenCalledTimes(1);
  return (await event.respondWith.mock.calls[0][0]) as Response;
}

describe("service worker version handshake", () => {
  it("reports the version embedded in the waiting worker", () => {
    const { messageHandler } = loadScript();
    const postMessage = vi.fn();
    messageHandler({ data: { type: "GET_WEB_VERSION" }, ports: [{ postMessage }] });
    expect(postMessage).toHaveBeenCalledWith({ type: "WEB_VERSION", version: "web-v2-test" });
  });
});

describe("service worker constants stay in sync with src/lib/offline", () => {
  it("uses the same cache names, chunk size, and headers", () => {
    const { internals } = loadScript();
    expect(internals.AUDIO_CACHE_NAME).toBe(OFFLINE_CACHE_NAMES.audio);
    expect(internals.DATA_CACHE_NAME).toBe(OFFLINE_CACHE_NAMES.data);
    expect(internals.SHELL_CACHE_NAME).toBe(OFFLINE_CACHE_NAMES.shell);
    expect(internals.STATIC_CACHE_NAME).toBe(OFFLINE_CACHE_NAMES.static);
    expect(internals.CHUNK_SIZE).toBe(AUDIO_CHUNK_SIZE);
    expect(internals.DOWNLOADS_PATH).toBe(DOWNLOADS_PATH);
    expect(internals.OFFLINE_RESPONSE_HEADER).toBe(OFFLINE_RESPONSE_HEADER);
    expect(internals.CACHED_AT_HEADER).toBe(CACHED_AT_HEADER);
  });

  it("derives identical audio cache keys", () => {
    const { internals } = loadScript();
    const urls = [
      `/api/catalogs/cat/recordings/${HASH}/audio`,
      `/api/catalogs/cat/recordings/${HASH}/audio?source=archived`,
      `/api/catalogs/cat/recordings/${HASH}/audio?source=listening&variant=loud`,
      `/api/catalogs/cat/recordings/${HASH}/audio?variant=loud&source=listening&download=true`,
    ];
    for (const url of urls) {
      const key = getAudioCacheKey(url, ORIGIN);
      expect(internals.getCacheKey(url)).toBe(key);
      expect(internals.getChunkKey(key, 3)).toBe(getAudioChunkKey(key, 3));
      expect(internals.getMetaKey(key)).toBe(getAudioMetaKey(key));
    }
  });

  it("allow-lists every URL the download manager pre-caches", () => {
    const { internals } = loadScript();
    const urls = [
      buildRecordingEntryUrl("cat", HASH),
      buildAudioSourcesUrl("cat", HASH),
      buildAudioSourcePreferenceUrl("cat", HASH),
      buildPlaybackProgressUrl("cat", HASH),
      buildTranscriptBackendsUrl(HASH, "cat"),
      buildTranscriptUrl(HASH, "cat", "whisperx/large"),
      buildTranscriptFormatsUrl(HASH, "cat", "whisperx/large"),
      buildDiarizationUrl(HASH, "cat", "pyannote"),
      buildEventDetailUrl("cat", 12),
      buildEventPosterUrl("cat", 12, "portrait", "2026-01-01"),
      "/api/auth/get-session",
      "/api/catalogs",
      "/api/catalogs/cat/features",
      "/api/catalog-events?page=1",
    ];
    for (const url of urls) {
      expect(internals.isCacheableDataPath(new URL(url, ORIGIN).pathname), url).toBe(true);
    }
    for (const url of [
      "/api/version",
      "/api/auth/sign-out",
      "/api/admin/users",
      "/api/mcp",
      `/api/catalogs/cat/recordings/${HASH}/audio`,
      "/api/telemetry/web-update",
    ]) {
      expect(internals.isCacheableDataPath(url), url).toBe(false);
    }
  });

  it("recognises shell routes", () => {
    const { internals } = loadScript();
    expect(internals.isShellPath("/catalog")).toBe(true);
    expect(internals.isShellPath("/catalog/cat")).toBe(true);
    expect(internals.isShellPath("/catalog/cat/event/12")).toBe(true);
    expect(internals.isShellPath(`/catalog/cat/recording/${HASH}`)).toBe(true);
    expect(internals.isShellPath("/downloads")).toBe(true);
    expect(internals.isShellPath("/admin")).toBe(false);
    expect(internals.isShellPath("/catalog/cat/settings")).toBe(false);
    expect(internals.isShellPath("/auth/signin")).toBe(false);
  });
});

describe("service worker navigation handling", () => {
  it("bypasses auth callback navigations", () => {
    const { fetchHandler, fetchMock } = loadScript();
    const event = createEvent("/api/auth/callback/google?code=abc&state=xyz", { mode: "navigate" });
    fetchHandler(event);
    expect(event.respondWith).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not log auth callback query params when bypassing auth navigation", () => {
    const { fetchHandler, consoleMock } = loadScript();
    fetchHandler(createEvent("/api/auth/callback/google?code=abc&state=xyz", { mode: "navigate" }));
    const logged = consoleMock.log.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain("code=abc");
    expect(logged).not.toContain("state=xyz");
  });

  it("fetches app navigations network-first and stores shell routes", async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    fetchMock.mockResolvedValueOnce(
      new Response("<html>catalog</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    );
    const event = createEvent("/catalog/cat?tab=events", { mode: "navigate" });
    fetchHandler(event);
    const response = await respondedWith(event);

    expect(fetchMock).toHaveBeenCalledWith(event.request, {
      credentials: "include",
      cache: "no-store",
    });
    expect(await response.text()).toBe("<html>catalog</html>");
    const shell = await cacheStorage.open(OFFLINE_CACHE_NAMES.shell);
    const stored = await shell.match("/catalog/cat");
    expect(stored).toBeDefined();
    expect(await stored!.text()).toBe("<html>catalog</html>");
  });

  it("does not store non-shell pages", async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    fetchMock.mockResolvedValueOnce(
      new Response("<html>admin</html>", { status: 200, headers: { "content-type": "text/html" } })
    );
    const event = createEvent("/admin", { mode: "navigate" });
    fetchHandler(event);
    await respondedWith(event);
    const shell = await cacheStorage.open(OFFLINE_CACHE_NAMES.shell);
    expect(await shell.keys()).toHaveLength(0);
  });

  it("serves the cached page when offline", async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    const shell = await cacheStorage.open(OFFLINE_CACHE_NAMES.shell);
    await shell.put(
      "/catalog/cat/event/12",
      new Response("<html>event</html>", { headers: { "content-type": "text/html" } })
    );
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const event = createEvent("/catalog/cat/event/12", { mode: "navigate" });
    fetchHandler(event);
    const response = await respondedWith(event);

    expect(response.status).toBe(200);
    expect(response.headers.get(OFFLINE_RESPONSE_HEADER)).toBe("1");
    expect(await response.text()).toBe("<html>event</html>");
  });

  it("redirects offline navigations to the Downloads page when that is cached", async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    const shell = await cacheStorage.open(OFFLINE_CACHE_NAMES.shell);
    await shell.put(DOWNLOADS_PATH, new Response("<html>downloads</html>"));
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const event = createEvent("/catalog/cat/event/99?x=1", { mode: "navigate" });
    fetchHandler(event);
    const response = await respondedWith(event);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/downloads?from=${encodeURIComponent("/catalog/cat/event/99?x=1")}`
    );
  });

  it("falls back to the inline offline page when nothing is cached", async () => {
    const { fetchHandler, fetchMock } = loadScript();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const event = createEvent("/catalog", { mode: "navigate" });
    fetchHandler(event);
    const response = await respondedWith(event);

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("You're offline");
  });
});

describe("service worker data caching", () => {
  it("stores successful JSON responses and replays them offline", async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    const url = buildRecordingEntryUrl("cat", HASH);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ entry: { hash: HASH } }), {
        status: 200,
        headers: { "content-type": "application/json", vary: "Cookie" },
      })
    );

    const online = createEvent(url);
    fetchHandler(online);
    const liveResponse = await respondedWith(online);
    expect(await liveResponse.json()).toEqual({ entry: { hash: HASH } });

    const data = await cacheStorage.open(OFFLINE_CACHE_NAMES.data);
    const stored = await data.match(url);
    expect(stored).toBeDefined();
    expect(stored!.headers.get(CACHED_AT_HEADER)).toMatch(/^\d+$/);

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const offline = createEvent(url);
    fetchHandler(offline);
    const cachedResponse = await respondedWith(offline);
    expect(cachedResponse.headers.get(OFFLINE_RESPONSE_HEADER)).toBe("1");
    expect(await cachedResponse.json()).toEqual({ entry: { hash: HASH } });
  });

  it("never stores error responses and does not mask them with cache", async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    const url = buildRecordingEntryUrl("cat", HASH);
    const data = await cacheStorage.open(OFFLINE_CACHE_NAMES.data);
    await data.put(url, new Response(JSON.stringify({ stale: true })));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "denied" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );

    const event = createEvent(url);
    fetchHandler(event);
    const response = await respondedWith(event);
    expect(response.status).toBe(403);
    expect(await (await data.match(url))!.json()).toEqual({ stale: true });
  });

  it("does not store a signed-out session", async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    fetchMock.mockResolvedValueOnce(
      new Response("null", { status: 200, headers: { "content-type": "application/json" } })
    );
    const event = createEvent("/api/auth/get-session");
    fetchHandler(event);
    await respondedWith(event);
    const data = await cacheStorage.open(OFFLINE_CACHE_NAMES.data);
    expect(await data.match("/api/auth/get-session")).toBeUndefined();
  });

  it("leaves non-allow-listed API requests to the browser", () => {
    const { fetchHandler } = loadScript();
    const version = createEvent("/api/version");
    fetchHandler(version);
    expect(version.respondWith).not.toHaveBeenCalled();

    const mutation = createEvent(buildPlaybackProgressUrl("cat", HASH), { method: "PUT" });
    fetchHandler(mutation);
    expect(mutation.respondWith).not.toHaveBeenCalled();
  });

  it("serves build assets cache-first", async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    const url = "/_next/static/chunks/app.js";
    const staticCache = await cacheStorage.open(OFFLINE_CACHE_NAMES.static);
    await staticCache.put(url, new Response("cached-js"));

    const event = createEvent(url);
    fetchHandler(event);
    const response = await respondedWith(event);
    expect(await response.text()).toBe("cached-js");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("service worker audio serving", () => {
  const audioUrl = `/api/catalogs/cat/recordings/${HASH}/audio`;

  async function seedAudio(cacheStorage: MemoryCacheStorage, complete: boolean) {
    const cache = await cacheStorage.open(OFFLINE_CACHE_NAMES.audio);
    const key = getAudioCacheKey(audioUrl, ORIGIN);
    const chunkA = new Uint8Array([1, 2, 3, 4]);
    const chunkB = new Uint8Array([5, 6, 7]);
    await cache.put(getAudioChunkKey(key, 0), new Response(chunkA));
    await cache.put(getAudioChunkKey(key, 1), new Response(chunkB));
    await cache.put(
      getAudioMetaKey(key),
      new Response(
        JSON.stringify({
          totalSize: 7,
          chunkCount: 2,
          chunkSizes: [4, 3],
          contentType: "audio/webm",
          complete,
        })
      )
    );
  }

  it("passes uncached audio straight to the network", async () => {
    const { fetchHandler, fetchMock } = loadScript();
    const event = createEvent(audioUrl, { headers: { range: "bytes=0-" } });
    fetchHandler(event);
    await respondedWith(event);
    expect(fetchMock).toHaveBeenCalledWith(event.request);
  });

  it("does not intercept the audio sources endpoint as audio", () => {
    const { fetchHandler, fetchMock } = loadScript();
    const event = createEvent(buildAudioSourcesUrl("cat", HASH));
    fetchHandler(event);
    // Handled as a data request: fetched through the data handler, not passed as raw audio.
    expect(event.respondWith).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(event.request);
  });

  it("never intercepts file downloads", () => {
    const { fetchHandler } = loadScript();
    const event = createEvent(`${audioUrl}?download=true`);
    fetchHandler(event);
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it("serves a byte range spanning two chunks from a complete cache", async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    await seedAudio(cacheStorage, true);

    const event = createEvent(audioUrl, { headers: { range: "bytes=2-5" } });
    fetchHandler(event);
    const response = await respondedWith(event);

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/7");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([3, 4, 5, 6]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the whole file without a Range header", async () => {
    const { fetchHandler, cacheStorage } = loadScript();
    await seedAudio(cacheStorage, true);

    const event = createEvent(audioUrl);
    fetchHandler(event);
    const response = await respondedWith(event);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("7");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("falls back to the network while a download is still in progress", async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    await seedAudio(cacheStorage, false);

    const event = createEvent(audioUrl, { headers: { range: "bytes=0-3" } });
    fetchHandler(event);
    await respondedWith(event);
    expect(fetchMock).toHaveBeenCalledWith(event.request);
  });

  it("answers unsatisfiable ranges with 416", async () => {
    const { fetchHandler, cacheStorage } = loadScript();
    await seedAudio(cacheStorage, true);

    const event = createEvent(audioUrl, { headers: { range: "bytes=10-" } });
    fetchHandler(event);
    const response = await respondedWith(event);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */7");
  });
});

describe("service worker parseRangeHeader", () => {
  const parse = () => loadScript().internals.parseRangeHeader;

  it("parses closed ranges (bytes=N-M)", () => {
    expect(parse()("bytes=100-199", 1000)).toEqual({ kind: "range", start: 100, end: 199 });
  });

  it("parses open-ended ranges (bytes=N-)", () => {
    expect(parse()("bytes=100-", 1000)).toEqual({ kind: "range", start: 100, end: 999 });
  });

  it("parses suffix ranges (bytes=-N)", () => {
    expect(parse()("bytes=-100", 1000)).toEqual({ kind: "range", start: 900, end: 999 });
  });

  it("clamps the end to totalSize-1 for oversized closed ranges", () => {
    expect(parse()("bytes=100-5000", 1000)).toEqual({ kind: "range", start: 100, end: 999 });
  });

  it("clamps suffix ranges larger than the file to the whole file", () => {
    expect(parse()("bytes=-5000", 1000)).toEqual({ kind: "range", start: 0, end: 999 });
  });

  it("returns unsatisfiable on bytes=-0", () => {
    expect(parse()("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("returns unsatisfiable when start >= totalSize", () => {
    expect(parse()("bytes=1000-", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("returns invalid on bytes=- with no numbers", () => {
    expect(parse()("bytes=-", 1000)).toEqual({ kind: "invalid" });
  });

  it("returns invalid on garbage headers", () => {
    expect(parse()("items=1-2", 1000)).toEqual({ kind: "invalid" });
  });

  it("returns invalid on null", () => {
    expect(parse()(null, 1000)).toEqual({ kind: "invalid" });
  });
});
