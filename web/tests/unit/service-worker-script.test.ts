import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type FetchHandlerEvent = {
  request: {
    headers: { get: (name: string) => string | null };
    method: string;
    mode: string;
    url: string;
  };
  respondWith: ReturnType<typeof vi.fn>;
};

type RangeParseResult =
  | { kind: "invalid" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; start: number; end: number };

type ScriptContext = {
  fetchHandler?: (event: FetchHandlerEvent) => void;
  messageHandler?: (event: {
    data: unknown;
    ports: Array<{ postMessage: (message: unknown) => void }>;
    source?: unknown;
  }) => void;
  parseRangeHeader: (rangeHeader: string | null, totalSize: number) => RangeParseResult;
  cleanupPartialCache: (cache: unknown, baseKey: string) => Promise<void>;
  hasActiveCleanup: (hash: string | null) => boolean;
  hashFromAudioKey: (baseKey: string | null) => string | null;
  cachesMock: { delete: ReturnType<typeof vi.fn>; keys: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> };
  consoleMock: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  fetchMock: ReturnType<typeof vi.fn>;
};

function loadScript(): ScriptContext {
  const listeners = new Map<string, (event: FetchHandlerEvent) => void>();
  const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
  const cachesMock = {
    delete: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
    open: vi.fn(),
  };
  const consoleMock = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const selfScope = {
    __BESEDY_WEB_VERSION: "web-v2-test",
    addEventListener: vi.fn((type: string, handler: (event: FetchHandlerEvent) => void) => {
      listeners.set(type, handler);
    }),
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn(),
      openWindow: vi.fn(),
    },
    location: { origin: "https://besedy.test" },
    registration: { showNotification: vi.fn() },
    skipWaiting: vi.fn(),
  };

  const script = fs.readFileSync(path.resolve(process.cwd(), "public/sw.js"), "utf8");
  const sandbox: Record<string, unknown> = {
    Map,
    Promise,
    Response,
    URL,
    caches: cachesMock,
    clients: selfScope.clients,
    console: consoleMock,
    fetch: fetchMock,
    self: selfScope,
  };
  vm.runInNewContext(script, sandbox);

  return {
    fetchHandler: listeners.get("fetch"),
    messageHandler: listeners.get("message") as ScriptContext["messageHandler"],
    parseRangeHeader: sandbox.parseRangeHeader as ScriptContext["parseRangeHeader"],
    cleanupPartialCache: sandbox.cleanupPartialCache as ScriptContext["cleanupPartialCache"],
    hasActiveCleanup: sandbox.hasActiveCleanup as ScriptContext["hasActiveCleanup"],
    hashFromAudioKey: sandbox.hashFromAudioKey as ScriptContext["hashFromAudioKey"],
    cachesMock,
    consoleMock,
    fetchMock,
  };
}

function loadFetchHandler() {
  const ctx = loadScript();
  if (!ctx.fetchHandler) {
    throw new Error("Failed to register service worker fetch handler");
  }
  return {
    cachesMock: ctx.cachesMock,
    consoleMock: ctx.consoleMock,
    fetchHandler: ctx.fetchHandler,
    fetchMock: ctx.fetchMock,
  };
}

function createNavigateEvent(url: string): FetchHandlerEvent {
  return {
    request: {
      headers: { get: () => null },
      method: "GET",
      mode: "navigate",
      url,
    },
    respondWith: vi.fn(),
  };
}

function createApiEvent(url: string): FetchHandlerEvent {
  return {
    request: {
      headers: { get: () => null },
      method: "GET",
      mode: "cors",
      url,
    },
    respondWith: vi.fn(),
  };
}

describe("service worker version handshake", () => {
  it("reports the version embedded in the waiting worker", () => {
    const { messageHandler } = loadScript();
    const postMessage = vi.fn();

    messageHandler?.({
      data: { type: "GET_WEB_VERSION" },
      ports: [{ postMessage }],
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: "WEB_VERSION",
      version: "web-v2-test",
    });
  });
});

describe("service worker navigation handling", () => {
  it("bypasses auth callback navigations", () => {
    const { fetchHandler, fetchMock } = loadFetchHandler();

    for (const url of [
      "https://besedy.test/api/auth/callback/google",
      "https://besedy.test/mock-oauth/authorize",
    ]) {
      const event = createNavigateEvent(url);
      fetchHandler(event);

      expect(event.respondWith).not.toHaveBeenCalled();
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not log auth callback query params when bypassing auth navigation", () => {
    const { consoleMock, fetchHandler } = loadFetchHandler();
    const event = createNavigateEvent(
      "https://besedy.test/api/auth/callback/google?code=secret-code&state=secret-state"
    );

    fetchHandler(event);

    expect(consoleMock.log).toHaveBeenCalledWith(
      "[SW] Bypassing auth navigation:",
      "/api/auth/callback/google"
    );
    expect(consoleMock.log).not.toHaveBeenCalledWith(
      "[SW] Bypassing auth navigation:",
      "https://besedy.test/api/auth/callback/google?code=secret-code&state=secret-state"
    );
  });

  it("intercepts normal app navigations with a network-first fetch", () => {
    const { fetchHandler, fetchMock } = loadFetchHandler();
    const event = createNavigateEvent("https://besedy.test/catalog");

    fetchHandler(event);

    expect(event.respondWith).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(event.request, {
      cache: "no-store",
      credentials: "include",
    });
  });

  it("keeps transcript API requests network-only", async () => {
    const { cachesMock, fetchHandler, fetchMock } = loadFetchHandler();
    const event = createApiEvent(
      `https://besedy.test/api/transcript/${"a".repeat(64)}?group=test`
    );

    fetchHandler(event);

    expect(event.respondWith).toHaveBeenCalledTimes(1);
    expect(cachesMock.open).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(event.request, {
      cache: "no-store",
      credentials: "include",
    });

    await event.respondWith.mock.calls[0]?.[0];
  });
});

describe("service worker parseRangeHeader", () => {
  it("parses closed ranges (bytes=N-M)", () => {
    const { parseRangeHeader } = loadScript();
    expect(parseRangeHeader("bytes=100-199", 1000)).toEqual({
      kind: "range",
      start: 100,
      end: 199,
    });
  });

  it("parses open-ended ranges (bytes=N-)", () => {
    const { parseRangeHeader } = loadScript();
    expect(parseRangeHeader("bytes=500-", 1000)).toEqual({
      kind: "range",
      start: 500,
      end: 999,
    });
  });

  it("parses suffix ranges (bytes=-N)", () => {
    const { parseRangeHeader } = loadScript();
    expect(parseRangeHeader("bytes=-250", 1000)).toEqual({
      kind: "range",
      start: 750,
      end: 999,
    });
  });

  it("clamps the end to totalSize-1 for oversized closed ranges", () => {
    const { parseRangeHeader } = loadScript();
    expect(parseRangeHeader("bytes=0-99999", 1000)).toEqual({
      kind: "range",
      start: 0,
      end: 999,
    });
  });

  it("clamps suffix ranges larger than the file to the whole file", () => {
    const { parseRangeHeader } = loadScript();
    expect(parseRangeHeader("bytes=-5000", 1000)).toEqual({
      kind: "range",
      start: 0,
      end: 999,
    });
  });

  it("returns unsatisfiable on bytes=-0", () => {
    const { parseRangeHeader } = loadScript();
    expect(parseRangeHeader("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("returns unsatisfiable when start >= totalSize", () => {
    const { parseRangeHeader } = loadScript();
    expect(parseRangeHeader("bytes=1000-", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("returns invalid on bytes=- with no numbers", () => {
    const { parseRangeHeader } = loadScript();
    expect(parseRangeHeader("bytes=-", 1000)).toEqual({ kind: "invalid" });
  });

  it("returns invalid on garbage headers", () => {
    const { parseRangeHeader } = loadScript();
    expect(parseRangeHeader("junk", 1000)).toEqual({ kind: "invalid" });
  });

  it("returns invalid on null", () => {
    const { parseRangeHeader } = loadScript();
    expect(parseRangeHeader(null, 1000)).toEqual({ kind: "invalid" });
  });
});

describe("service worker cleanup lock", () => {
  const hash = "a".repeat(64);
  const baseKey = `https://besedy.test/api/catalogs/20250101_120000/recordings/${hash}/audio`;

  it("hashFromAudioKey extracts the hash from a canonical audio URL", () => {
    const { hashFromAudioKey } = loadScript();
    expect(hashFromAudioKey(baseKey)).toBe(hash);
    expect(hashFromAudioKey(null)).toBeNull();
    expect(hashFromAudioKey("https://besedy.test/other")).toBeNull();
  });

  it("holds the cleanup lock across the entire delete loop", async () => {
    const { cleanupPartialCache, hasActiveCleanup, cachesMock } = loadScript();

    // `cache.keys()` resolves when we call resolveKeys; this lets us observe
    // state *during* the delete loop.
    let resolveKeys: ((keys: unknown[]) => void) | undefined;
    cachesMock.keys = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveKeys = (keys) => resolve(keys);
        })
    );
    cachesMock.delete = vi.fn().mockResolvedValue(true);

    // Lock is not held before the call.
    expect(hasActiveCleanup(hash)).toBe(false);

    const done = cleanupPartialCache(cachesMock as unknown, baseKey);

    // The lock must be set synchronously before any await.
    expect(hasActiveCleanup(hash)).toBe(true);

    // Finish the cache.keys() promise so the loop can run (with no keys to
    // delete — the loop logic is unrelated to this test).
    resolveKeys!([]);
    await done;

    // Lock released on exit.
    expect(hasActiveCleanup(hash)).toBe(false);
  });

  it("refuses to start cleanup while another cleanup holds the lock", async () => {
    const { cleanupPartialCache, hasActiveCleanup, cachesMock } = loadScript();

    // Pin the first cleanup inside its delete loop via a pending keys() promise.
    let resolveKeys: ((keys: unknown[]) => void) | undefined;
    cachesMock.keys = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveKeys = (keys) => resolve(keys);
        })
    );
    const deleteMock = vi.fn().mockResolvedValue(true);
    cachesMock.delete = deleteMock;

    const first = cleanupPartialCache(cachesMock as unknown, baseKey);
    expect(hasActiveCleanup(hash)).toBe(true);

    // Second cleanup for the same hash while the first is still holding the
    // lock: must be a no-op (doesn't call cache.keys, doesn't delete).
    const keysCallsBefore = (cachesMock.keys as ReturnType<typeof vi.fn>).mock.calls.length;
    await cleanupPartialCache(cachesMock as unknown, baseKey);
    expect((cachesMock.keys as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      keysCallsBefore
    );
    expect(deleteMock).not.toHaveBeenCalled();

    resolveKeys!([]);
    await first;
    expect(hasActiveCleanup(hash)).toBe(false);
  });
});
