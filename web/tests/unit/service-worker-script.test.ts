import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_CHUNK_SIZE,
  getAudioCacheKey,
  getAudioChunkKey,
  getAudioMetaKey,
} from '@/lib/offline/audio-cache-format';
import {
  DOWNLOADS_PATH,
  OFFLINE_CACHE_NAMES,
  OFFLINE_RESPONSE_HEADER,
} from '@/lib/offline/cache-names';

const ORIGIN = 'https://besedy.test';
const HASH = 'a'.repeat(64);

type FetchHandlerEvent = {
  request: Request;
  respondWith: ReturnType<typeof vi.fn>;
};

type RangeParseResult =
  | { kind: 'full' }
  | { kind: 'invalid' }
  | { kind: 'unsatisfiable' }
  | { kind: 'range'; start: number; end: number };

interface SwInternals {
  AUDIO_CACHE_NAME: string;
  SHELL_CACHE_NAME: string;
  STATIC_CACHE_NAME: string;
  CHUNK_SIZE: number;
  DOWNLOADS_PATH: string;
  OFFLINE_RESPONSE_HEADER: string;
  getCacheKey: (url: string) => string;
  getChunkKey: (baseKey: string, index: number) => string;
  getMetaKey: (baseKey: string) => string;
  isAudioCacheEntryFor: (baseKey: string, entryUrl: string) => boolean;
  isDownloadsPath: (pathname: string) => boolean;
  parseRangeHeader: (
    rangeHeader: string | null,
    totalSize: number,
  ) => RangeParseResult;
}

class MemoryCache {
  store = new Map<string, Response>();

  private key(request: RequestInfo | URL): string {
    if (typeof request === 'string') return new URL(request, ORIGIN).toString();
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
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response('network', { status: 200 }));
  const cacheStorage = new MemoryCacheStorage();
  const consoleMock = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const selfScope: Record<string, unknown> = {
    __BESEDY_WEB_VERSION: 'web-v2-test',
    addEventListener: vi.fn(
      (type: string, handler: (event: unknown) => void) => {
        listeners.set(type, handler);
      },
    ),
    clients: { claim: vi.fn(), matchAll: vi.fn(), openWindow: vi.fn() },
    location: { origin: ORIGIN },
    registration: { showNotification: vi.fn() },
    skipWaiting: vi.fn(),
  };

  const script = fs.readFileSync(
    path.resolve(process.cwd(), 'public/sw.js'),
    'utf8',
  );
  const sandbox: Record<string, unknown> = {
    Map,
    Promise,
    Response,
    Request,
    Headers,
    URL,
    Uint8Array,
    Number,
    ReadableStream,
    caches: cacheStorage,
    clients: selfScope.clients,
    console: consoleMock,
    fetch: fetchMock,
    self: selfScope,
  };
  vm.runInNewContext(script, sandbox);

  const fetchHandler = listeners.get('fetch') as
    ((event: FetchHandlerEvent) => void) | undefined;
  if (!fetchHandler)
    throw new Error('Failed to register service worker fetch handler');

  return {
    fetchHandler,
    messageHandler: listeners.get('message') as (event: {
      data: unknown;
      ports: Array<{ postMessage: (message: unknown) => void }>;
    }) => void,
    internals: selfScope.__BESEDY_SW_INTERNALS as SwInternals,
    cacheStorage,
    fetchMock,
  };
}

function createEvent(
  url: string,
  init: RequestInit & { mode?: RequestMode } = {},
): FetchHandlerEvent {
  const { mode, ...requestInit } = init;
  const request = new Request(new URL(url, ORIGIN).toString(), requestInit);
  if (mode === 'navigate') {
    Object.defineProperty(request, 'mode', { value: 'navigate' });
  }
  return { request, respondWith: vi.fn() };
}

async function respondedWith(event: FetchHandlerEvent): Promise<Response> {
  expect(event.respondWith).toHaveBeenCalledTimes(1);
  return (await event.respondWith.mock.calls[0][0]) as Response;
}

async function seedAudio(
  cacheStorage: MemoryCacheStorage,
  chunks: Uint8Array[],
  options: { complete?: boolean } = {},
) {
  const url = `/api/catalogs/cat/recordings/${HASH}/audio`;
  const baseKey = getAudioCacheKey(url, ORIGIN);
  const cache = await cacheStorage.open(OFFLINE_CACHE_NAMES.audio);
  await cache.put(
    getAudioMetaKey(baseKey),
    new Response(
      JSON.stringify({
        totalSize: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
        chunkCount: chunks.length,
        chunkSizes: chunks.map((chunk) => chunk.byteLength),
        contentType: 'audio/webm',
        complete: options.complete ?? true,
      }),
    ),
  );
  await Promise.all(
    chunks.map((chunk, index) =>
      cache.put(
        getAudioChunkKey(baseKey, index),
        new Response(Uint8Array.from(chunk).buffer),
      ),
    ),
  );
  return { url, baseKey, cache };
}

describe('service worker version handshake', () => {
  it('reports the version embedded in the waiting worker', () => {
    const { messageHandler } = loadScript();
    const postMessage = vi.fn();
    messageHandler({
      data: { type: 'GET_WEB_VERSION' },
      ports: [{ postMessage }],
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'WEB_VERSION',
      version: 'web-v2-test',
    });
  });
});

describe('service worker constants', () => {
  it('stays in sync with the page-side cache format', () => {
    const { internals } = loadScript();
    expect(internals.AUDIO_CACHE_NAME).toBe(OFFLINE_CACHE_NAMES.audio);
    expect(internals.SHELL_CACHE_NAME).toBe(OFFLINE_CACHE_NAMES.shell);
    expect(internals.STATIC_CACHE_NAME).toBe(OFFLINE_CACHE_NAMES.static);
    expect(internals.CHUNK_SIZE).toBe(AUDIO_CHUNK_SIZE);
    expect(internals.DOWNLOADS_PATH).toBe(DOWNLOADS_PATH);
    expect(internals.OFFLINE_RESPONSE_HEADER).toBe(OFFLINE_RESPONSE_HEADER);
  });

  it('derives the same normalized audio keys', () => {
    const { internals } = loadScript();
    for (const url of [
      `/api/catalogs/cat/recordings/${HASH}/audio`,
      `/api/catalogs/cat/recordings/${HASH}/audio?source=archived`,
      `/api/catalogs/cat/recordings/${HASH}/audio?source=listening&variant=loud`,
    ]) {
      const key = getAudioCacheKey(url, ORIGIN);
      expect(internals.getCacheKey(url)).toBe(key);
      expect(internals.getChunkKey(key, 3)).toBe(getAudioChunkKey(key, 3));
      expect(internals.getMetaKey(key)).toBe(getAudioMetaKey(key));
    }
  });

  it('only recognizes the dedicated Downloads pathname as an offline shell', () => {
    const { internals } = loadScript();
    expect(internals.isDownloadsPath('/downloads')).toBe(true);
    expect(internals.isDownloadsPath('/downloads/')).toBe(true);
    expect(internals.isDownloadsPath('/catalog/cat')).toBe(false);
  });
});

describe('downloaded audio', () => {
  it('streams a cross-chunk byte range from Cache Storage', async () => {
    const { fetchHandler, cacheStorage, fetchMock } = loadScript();
    const first = new Uint8Array([0, 1, 2, 3, 4]);
    const second = new Uint8Array([5, 6, 7, 8, 9]);
    const { url } = await seedAudio(cacheStorage, [first, second]);

    const event = createEvent(url, { headers: { Range: 'bytes=3-7' } });
    fetchHandler(event);
    const response = await respondedWith(event);

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 3-7/10');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      3, 4, 5, 6, 7,
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams an open-ended range instead of concatenating it before responding', async () => {
    const { fetchHandler, cacheStorage } = loadScript();
    const { url } = await seedAudio(cacheStorage, [
      new Uint8Array([0, 1, 2]),
      new Uint8Array([3, 4, 5]),
      new Uint8Array([6, 7, 8]),
    ]);

    const event = createEvent(url, { headers: { Range: 'bytes=2-' } });
    fetchHandler(event);
    const response = await respondedWith(event);

    expect(response.body).toBeInstanceOf(ReadableStream);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('rejects malformed and reversed ranges', () => {
    const { internals } = loadScript();
    expect(internals.parseRangeHeader('bytes=9-2', 10)).toEqual({
      kind: 'unsatisfiable',
    });
    expect(internals.parseRangeHeader('bytes=0-1,4-5', 10)).toEqual({
      kind: 'invalid',
    });
    expect(internals.parseRangeHeader(null, 10)).toEqual({ kind: 'full' });
  });

  it('uses the network when no complete download exists', async () => {
    const { fetchHandler, fetchMock } = loadScript();
    const event = createEvent(`/api/catalogs/cat/recordings/${HASH}/audio`);
    fetchHandler(event);
    const response = await respondedWith(event);
    expect(await response.text()).toBe('network');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('offline shell routing', () => {
  it('stores and replays only the Downloads document', async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    fetchMock.mockResolvedValueOnce(
      new Response('<html>downloads</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    const online = createEvent('/downloads', { mode: 'navigate' });
    fetchHandler(online);
    expect(await (await respondedWith(online)).text()).toContain('downloads');

    const shell = await cacheStorage.open(OFFLINE_CACHE_NAMES.shell);
    expect(await shell.match(DOWNLOADS_PATH)).toBeDefined();

    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const offline = createEvent('/downloads?item=cat%3Ahash', {
      mode: 'navigate',
    });
    fetchHandler(offline);
    const replay = await respondedWith(offline);
    expect(await replay.text()).toContain('downloads');
    expect(replay.headers.get(OFFLINE_RESPONSE_HEADER)).toBe('1');
  });

  it('redirects a failed normal navigation to Downloads without caching the page', async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    const shell = await cacheStorage.open(OFFLINE_CACHE_NAMES.shell);
    await shell.put(DOWNLOADS_PATH, new Response('<html>downloads</html>'));
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));

    const event = createEvent('/catalog/cat/event/7', { mode: 'navigate' });
    fetchHandler(event);
    const response = await respondedWith(event);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/downloads?from=');
    expect(await shell.match('/catalog/cat/event/7')).toBeUndefined();
  });

  it('does not intercept JSON API reads', () => {
    const { fetchHandler } = loadScript();
    const event = createEvent(`/api/transcript/${HASH}`);
    fetchHandler(event);
    expect(event.respondWith).not.toHaveBeenCalled();
  });
});
