import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_CHUNK_SIZE,
  getAudioCacheKey,
  getAudioChunkKey,
  getAudioMetaKey,
  getAudioCacheLockName,
  withAudioCacheLock,
} from '@/lib/offline/audio-cache-format';
import { MemoryLocks } from './helpers/memory-locks';
import {
  DOWNLOADS_PATH,
  OFFLINE_CACHE_NAMES,
  OFFLINE_RESPONSE_HEADER,
} from '@/lib/offline/cache-names';

const ORIGIN = 'https://besedy.test';
const HASH = 'a'.repeat(64);

type FetchHandlerEvent = {
  request: Request;
  clientId?: string;
  respondWith: ReturnType<typeof vi.fn>;
};

type RangeParseResult =
  | { kind: 'full' }
  | { kind: 'invalid' }
  | { kind: 'unsatisfiable' }
  | { kind: 'range'; start: number; end: number; suffix?: boolean };

interface SwInternals {
  AUDIO_CACHE_NAME: string;
  SHELL_CACHE_NAME: string;
  STATIC_CACHE_NAME: string;
  STATIC_CACHE_MAX_ENTRIES: number;
  CHUNK_SIZE: number;
  MAX_RANGE_RESPONSE_BYTES: number;
  DOWNLOADS_PATH: string;
  OFFLINE_RESPONSE_HEADER: string;
  getCacheKey: (url: string) => string;
  getChunkKey: (baseKey: string, index: number) => string;
  getMetaKey: (baseKey: string) => string;
  getAudioCacheLockName: (baseKey: string) => string;
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

function loadScript(options: { locks?: MemoryLocks | null } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response('network', { status: 200 }));
  const cacheStorage = new MemoryCacheStorage();
  const consoleMock = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clientUrls = new Map<string, string>();
  const locks = options.locks === undefined ? new MemoryLocks() : options.locks;
  const selfScope: Record<string, unknown> = {
    navigator: { locks },
    __BESEDY_WEB_VERSION: 'web-v2-test',
    addEventListener: vi.fn(
      (type: string, handler: (event: unknown) => void) => {
        listeners.set(type, handler);
      },
    ),
    clients: {
      claim: vi.fn(),
      get: vi.fn(async (id: string) => {
        const url = clientUrls.get(id);
        return url ? { url } : null;
      }),
      matchAll: vi.fn(),
      openWindow: vi.fn(),
    },
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
    clientUrls,
    fetchMock,
    locks,
  };
}

function createEvent(
  url: string,
  init: RequestInit & { clientId?: string; mode?: RequestMode } = {},
): FetchHandlerEvent {
  const { clientId, mode, ...requestInit } = init;
  const request = new Request(new URL(url, ORIGIN).toString(), requestInit);
  if (mode === 'navigate') {
    Object.defineProperty(request, 'mode', { value: 'navigate' });
  }
  return { request, clientId, respondWith: vi.fn() };
}

async function respondedWith(event: FetchHandlerEvent): Promise<Response> {
  expect(event.respondWith).toHaveBeenCalledTimes(1);
  return (await event.respondWith.mock.calls[0][0]) as Response;
}

/**
 * Hold the worker's next cache read until the test decides how it ends, so a
 * "read in flight" state does not depend on undici's timing. Only that one
 * read is gated; later reads (including the test's own) behave normally.
 */
function gateNextRead(cache: MemoryCache, snapshot = false, key?: string) {
  const original = cache.match;
  let markStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let settle!: (error?: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    settle = (error) => (error ? reject(error) : resolve());
  });
  cache.match = async (request) => {
    if (key !== undefined && request !== key) return original.call(cache, request);
    cache.match = original;
    const result = snapshot ? await original.call(cache, request) : undefined;
    markStarted();
    await gate;
    return snapshot ? result : original.call(cache, request);
  };
  return { readStarted, settle };
}

async function seedAudio(
  cacheStorage: MemoryCacheStorage,
  chunks: Uint8Array[],
  options: { complete?: boolean; generation?: string } = {},
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
        ...(options.generation ? { generation: options.generation } : {}),
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

afterEach(() => vi.unstubAllGlobals());

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
    expect(internals.STATIC_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
    expect(internals.CHUNK_SIZE).toBe(AUDIO_CHUNK_SIZE);
    expect(internals.DOWNLOADS_PATH).toBe(DOWNLOADS_PATH);
    expect(internals.OFFLINE_RESPONSE_HEADER).toBe(OFFLINE_RESPONSE_HEADER);
    expect(internals.getAudioCacheLockName('audio')).toBe(getAudioCacheLockName('audio'));
  });

  it('derives the same normalized audio keys', () => {
    const { internals } = loadScript();
    for (const url of [
      `/api/catalogs/cat/recordings/${HASH}/audio`,
      `/api/catalogs/cat/recordings/${HASH}/audio?source=archived`,
      `/api/catalogs/cat/recordings/${HASH}/audio?source=listening&variant=loud`,
      `/api/catalogs/cat/recordings/${HASH}/audio?format=aac`,
      `/api/catalogs/cat/recordings/${HASH}/audio?format=webm`,
      `/api/catalogs/cat/recordings/${HASH}/audio?source=listening&variant=loud&format=aac&local=1`,
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

  describe('range responses are capped', () => {
    // Real-size chunks, so the cap bites exactly as it does on a phone.
    function pattern(length: number, offset = 0) {
      return Uint8Array.from({ length }, (_, index) => (offset + index) % 251);
    }

    async function request(
      layout: number[],
      range: string | null,
      prepare?: (cache: MemoryCache, baseKey: string) => Promise<void>,
    ) {
      const { fetchHandler, cacheStorage, fetchMock } = loadScript();
      let offset = 0;
      const chunks = layout.map((length) => {
        const chunk = pattern(length, offset);
        offset += length;
        return chunk;
      });
      const { url, baseKey, cache } = await seedAudio(cacheStorage, chunks);
      await prepare?.(cache, baseKey);
      const event = createEvent(url, range ? { headers: { Range: range } } : {});
      fetchHandler(event);
      const response = await respondedWith(event);
      return { response, cache, baseKey, fetchMock, total: offset };
    }

    async function body(response: Response) {
      return new Uint8Array(await response.arrayBuffer());
    }

    // toEqual walks a 4 MiB array element by element; compare the bytes.
    function expectBytes(actual: Uint8Array, length: number, offset: number) {
      expect(actual.byteLength).toBe(length);
      expect(Buffer.from(actual).equals(Buffer.from(pattern(length, offset)))).toBe(true);
    }

    const { CHUNK_SIZE: CHUNK, MAX_RANGE_RESPONSE_BYTES: MAX } = loadScript().internals;

    it('is 4 MiB, two chunks at the default chunk size', () => {
      expect(MAX).toBe(4 * 1024 * 1024);
      expect(MAX).toBe(2 * CHUNK);
    });

    it('answers an open-ended range with at most the cap, as a stream', async () => {
      const { response, total } = await request([CHUNK, CHUNK, CHUNK], 'bytes=0-');
      expect(response.status).toBe(206);
      expect(response.body).toBeInstanceOf(ReadableStream);
      expect(response.headers.get('content-range')).toBe(`bytes 0-${MAX - 1}/${total}`);
      expect(response.headers.get('content-length')).toBe(String(MAX));
      expectBytes(await body(response), MAX, 0);
    });

    it('slices inside a chunk when the range starts mid-chunk', async () => {
      const { response, total } = await request([CHUNK, CHUNK, CHUNK], 'bytes=1000-');
      expect(response.headers.get('content-range')).toBe(
        `bytes 1000-${1000 + MAX - 1}/${total}`,
      );
      expectBytes(await body(response), MAX, 1000);
    });

    it('caps a recording stored as one large chunk', async () => {
      // A server that ignored Range leaves the whole file in chunk 0.
      const { response, total } = await request([3 * CHUNK], 'bytes=0-');
      expect(response.headers.get('content-range')).toBe(`bytes 0-${MAX - 1}/${total}`);
      expectBytes(await body(response), MAX, 0);
    });

    it('shortens an explicit range that asks for more than the cap', async () => {
      const { response, total } = await request(
        [CHUNK, CHUNK, CHUNK],
        `bytes=10-${10 + MAX + 5000}`,
      );
      expect(response.headers.get('content-range')).toBe(
        `bytes 10-${10 + MAX - 1}/${total}`,
      );
      expect(response.headers.get('content-length')).toBe(String(MAX));
    });

    it('keeps the tail of a suffix range', async () => {
      const { response, total } = await request([CHUNK, CHUNK, CHUNK], `bytes=-${MAX + 100}`);
      expect(response.headers.get('content-range')).toBe(
        `bytes ${total - MAX}-${total - 1}/${total}`,
      );
      expectBytes(await body(response), MAX, total - MAX);
    });

    it('serves the rest when the player asks for the next range', async () => {
      const { response, total } = await request([CHUNK, CHUNK, CHUNK], `bytes=${MAX}-`);
      expect(response.headers.get('content-range')).toBe(`bytes ${MAX}-${total - 1}/${total}`);
      expectBytes(await body(response), total - MAX, MAX);
    });

    it('keeps a request without Range whole, since a 200 cannot be short', async () => {
      const { response, total } = await request([CHUNK, CHUNK, CHUNK], null);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-range')).toBeNull();
      expect(response.headers.get('content-length')).toBe(String(total));
      expect((await body(response)).byteLength).toBe(total);
    });

    it('finds a gap anywhere in the requested range before serving any of it', async () => {
      const { response, cache, baseKey, fetchMock } = await request(
        [CHUNK, CHUNK, CHUNK],
        'bytes=0-',
        // Chunk 2 lies beyond the capped response but inside the request.
        async (cache, baseKey) => {
          await cache.delete(getAudioChunkKey(baseKey, 2));
        },
      );
      expect(await response.text()).toBe('network');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await cache.match(getAudioMetaKey(baseKey))).toBeUndefined();
    });
  });

  it('does not read a chunk until the player asks for bytes', async () => {
    const { fetchHandler, cacheStorage } = loadScript();
    const { url, cache } = await seedAudio(cacheStorage, [
      new Uint8Array([0, 1, 2]),
    ]);
    const match = vi.spyOn(cache, 'match');

    const event = createEvent(url, { headers: { Range: 'bytes=0-' } });
    fetchHandler(event);
    const response = await respondedWith(event);
    const chunkReads = () =>
      match.mock.calls.filter(([request]) =>
        String(request).includes('_chunk='),
      );
    // The range handler checks that the chunks exist before responding; the
    // stream itself must not start reading them for a header-only probe.
    const beforeRead = chunkReads().length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chunkReads()).toHaveLength(beforeRead);

    await response.body!.getReader().read();
    expect(chunkReads()).toHaveLength(beforeRead + 1);
  });

  it('keeps the download when the player abandons a response mid-read', async () => {
    const { fetchHandler, cacheStorage } = loadScript();
    const { url, baseKey, cache } = await seedAudio(cacheStorage, [
      new Uint8Array([0, 1, 2]),
      new Uint8Array([3, 4, 5]),
    ]);

    const event = createEvent(url, { headers: { Range: 'bytes=0-' } });
    fetchHandler(event);
    const response = await respondedWith(event);
    const { readStarted, settle } = gateNextRead(cache);
    const reader = response.body!.getReader();
    const read = reader.read();
    await readStarted;
    // A seek, or the headers being enough: the player cancels while the chunk
    // is still being read. That must not look like a damaged download.
    await reader.cancel();
    settle();
    await expect(read).resolves.toEqual({ done: true, value: undefined });

    expect(await cache.match(getAudioMetaKey(baseKey))).toBeDefined();
    expect(await cache.match(getAudioChunkKey(baseKey, 0))).toBeDefined();
    expect(await cache.match(getAudioChunkKey(baseKey, 1))).toBeDefined();
  });

  it('keeps the download when a read fails after the player cancelled', async () => {
    const { fetchHandler, cacheStorage } = loadScript();
    const { url, baseKey, cache } = await seedAudio(cacheStorage, [
      new Uint8Array([0, 1, 2]),
      new Uint8Array([3, 4, 5]),
    ]);

    const event = createEvent(url, { headers: { Range: 'bytes=0-' } });
    fetchHandler(event);
    const response = await respondedWith(event);
    const { readStarted, settle } = gateNextRead(cache);
    const reader = response.body!.getReader();
    const read = reader.read();
    await readStarted;
    await reader.cancel();
    settle(new Error('Cache Storage went away'));
    await expect(read).resolves.toEqual({ done: true, value: undefined });

    expect(await cache.match(getAudioMetaKey(baseKey))).toBeDefined();
    expect(await cache.match(getAudioChunkKey(baseKey, 0))).toBeDefined();
    expect(await cache.match(getAudioChunkKey(baseKey, 1))).toBeDefined();
  });

  it('discards a damaged download even after the player cancelled', async () => {
    const { fetchHandler, cacheStorage } = loadScript();
    const { url, baseKey, cache } = await seedAudio(cacheStorage, [
      new Uint8Array([0, 1, 2]),
      new Uint8Array([3, 4, 5]),
    ]);

    const event = createEvent(url, { headers: { Range: 'bytes=0-' } });
    fetchHandler(event);
    const response = await respondedWith(event);
    const { readStarted, settle } = gateNextRead(cache);
    const reader = response.body!.getReader();
    const read = reader.read();
    await readStarted;
    await reader.cancel();
    await cache.delete(getAudioChunkKey(baseKey, 0));
    settle();
    await expect(read).resolves.toEqual({ done: true, value: undefined });

    await vi.waitFor(async () => {
      expect(await cache.match(getAudioMetaKey(baseKey))).toBeUndefined();
    });
    expect(await cache.match(getAudioChunkKey(baseKey, 1))).toBeUndefined();
  });

  it('keeps the download when Cache Storage itself fails to read', async () => {
    const { fetchHandler, cacheStorage } = loadScript();
    const { url, baseKey, cache } = await seedAudio(cacheStorage, [
      new Uint8Array([0, 1, 2]),
      new Uint8Array([3, 4, 5]),
    ]);

    const event = createEvent(url, { headers: { Range: 'bytes=0-' } });
    fetchHandler(event);
    const response = await respondedWith(event);
    const { readStarted, settle } = gateNextRead(cache);
    const body = response.arrayBuffer();
    await readStarted;
    settle(new Error('QuotaExceededError'));

    await expect(body).rejects.toThrow('QuotaExceededError');
    expect(await cache.match(getAudioMetaKey(baseKey))).toBeDefined();
    expect(await cache.match(getAudioChunkKey(baseKey, 0))).toBeDefined();
    expect(await cache.match(getAudioChunkKey(baseKey, 1))).toBeDefined();
  });

  it('discards the download when a cached chunk is missing', async () => {
    const { fetchHandler, cacheStorage } = loadScript();
    const { url, baseKey, cache } = await seedAudio(cacheStorage, [
      new Uint8Array([0, 1, 2]),
      new Uint8Array([3, 4, 5]),
    ]);

    const event = createEvent(url, { headers: { Range: 'bytes=0-' } });
    fetchHandler(event);
    const response = await respondedWith(event);
    await cache.delete(getAudioChunkKey(baseKey, 1));

    await expect(response.arrayBuffer()).rejects.toThrow(
      'Missing audio chunk 1',
    );
    // The entries are gone by the time the response fails: the delete runs
    // before the stream is errored, so the player's retry cannot race it.
    expect(await cache.match(getAudioMetaKey(baseKey))).toBeUndefined();
    expect(await cache.match(getAudioChunkKey(baseKey, 0))).toBeUndefined();
  });

  it('discards the download when a cached chunk has the wrong size', async () => {
    const { fetchHandler, cacheStorage } = loadScript();
    const { url, baseKey, cache } = await seedAudio(cacheStorage, [
      new Uint8Array([0, 1, 2]),
      new Uint8Array([3, 4, 5]),
    ]);

    const event = createEvent(url, { headers: { Range: 'bytes=0-' } });
    fetchHandler(event);
    const response = await respondedWith(event);
    await cache.put(
      getAudioChunkKey(baseKey, 1),
      new Response(Uint8Array.from([3, 4]).buffer),
    );

    await expect(response.arrayBuffer()).rejects.toThrow('expected 3');
    expect(await cache.match(getAudioMetaKey(baseKey))).toBeUndefined();
    expect(await cache.match(getAudioChunkKey(baseKey, 0))).toBeUndefined();
  });

  it.each(['missing', 'wrong-size'])(
    'keeps a replacement when an old %s chunk read finishes late',
    async (damage) => {
      const { fetchHandler, cacheStorage, locks } = loadScript();
      vi.stubGlobal('navigator', { locks });
      // Legacy downloads have no generation marker. Their replacement does,
      // even when its sizes and bytes are otherwise identical.
      const chunks = [new Uint8Array([0, 1, 2]), new Uint8Array([3, 4, 5])];
      const { url, baseKey, cache } = await seedAudio(cacheStorage, chunks);
      const event = createEvent(url, { headers: { Range: 'bytes=0-' } });
      fetchHandler(event);
      const response = await respondedWith(event);
      if (damage === 'missing') {
        await cache.delete(getAudioChunkKey(baseKey, 0));
      } else {
        await cache.put(getAudioChunkKey(baseKey, 0), new Response(new Uint8Array([0])));
      }
      const { readStarted, settle } = gateNextRead(cache, true);
      const failed = expect(response.arrayBuffer()).rejects.toThrow(
        damage === 'missing' ? 'Missing audio chunk' : 'expected 3',
      );
      await readStarted;
      await withAudioCacheLock(baseKey, async () => {
        await seedAudio(cacheStorage, chunks, { generation: 'replacement' });
      });
      settle();
      await failed;
      expect(await (await cache.match(getAudioMetaKey(baseKey)))!.json())
        .toMatchObject({ generation: 'replacement', complete: true });
      expect(await (await cache.match(getAudioChunkKey(baseKey, 0)))!.arrayBuffer())
        .toEqual(chunks[0].buffer);
      expect(await cache.match(getAudioChunkKey(baseKey, 1))).toBeDefined();
    },
  );

  it('does not let a second failing reader delete a download repaired after the first cleanup', async () => {
    const { fetchHandler, cacheStorage, locks } = loadScript();
    vi.stubGlobal('navigator', { locks });
    const chunks = [new Uint8Array([0, 1, 2])];
    const { url, baseKey, cache } = await seedAudio(cacheStorage, chunks, { generation: 'old' });
    const events = [createEvent(url), createEvent(url)];
    events.forEach(fetchHandler);
    const [first, second] = await Promise.all(events.map(respondedWith));
    await cache.put(getAudioChunkKey(baseKey, 0), new Response(new Uint8Array([0])));
    const firstRead = gateNextRead(cache, true);
    const firstFailed = expect(first.arrayBuffer()).rejects.toThrow('expected 3');
    await firstRead.readStarted;
    const secondRead = gateNextRead(cache, true);
    const secondFailed = expect(second.arrayBuffer()).rejects.toThrow('expected 3');
    await secondRead.readStarted;
    firstRead.settle();
    await firstFailed;
    expect(await cache.keys()).toHaveLength(0);
    await withAudioCacheLock(baseKey, async () => {
      await seedAudio(cacheStorage, chunks, { generation: 'new' });
    });
    secondRead.settle();
    await secondFailed;
    expect(await cache.keys()).toHaveLength(2);
  });

  it('holds the storage lock through cleanup so a replacement cannot be partly deleted', async () => {
    const { fetchHandler, cacheStorage, locks } = loadScript();
    vi.stubGlobal('navigator', { locks });
    const chunks = [new Uint8Array([0, 1, 2])];
    const { url, baseKey, cache } = await seedAudio(cacheStorage, chunks);
    const event = createEvent(url);
    fetchHandler(event);
    const response = await respondedWith(event);
    await cache.delete(getAudioChunkKey(baseKey, 0));
    let markCleanup!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanup = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const originalKeys = cache.keys.bind(cache);
    cache.keys = async () => {
      markCleanup();
      await cleanupGate;
      return originalKeys();
    };
    const failed = expect(response.arrayBuffer()).rejects.toThrow('Missing audio chunk');
    await cleanupStarted;
    let replacementStarted = false;
    const replacement = withAudioCacheLock(baseKey, async () => {
      replacementStarted = true;
      await seedAudio(cacheStorage, chunks, { generation: 'new' });
    });
    try {
      expect(locks!.isHeld(getAudioCacheLockName(baseKey))).toBe(true);
      expect(replacementStarted).toBe(false);
    } finally {
      releaseCleanup();
      await Promise.all([failed, replacement]);
    }
    expect(await cache.keys()).toHaveLength(2);
    expect(await (await cache.match(getAudioMetaKey(baseKey)))!.json())
      .toMatchObject({ generation: 'new' });
  });

  it.each(['invalid-json', 'invalid-shape', 'inconsistent-sizes'])(
    'keeps a replacement when an old %s metadata read finishes late',
    async (damage) => {
      const { fetchHandler, cacheStorage, locks } = loadScript();
      vi.stubGlobal('navigator', { locks });
      const chunks = [new Uint8Array([0, 1, 2])];
      const { url, baseKey, cache } = await seedAudio(cacheStorage, chunks);
      const old = await (await cache.match(getAudioMetaKey(baseKey)))!.json();
      const damaged = damage === 'invalid-json'
        ? 'not json'
        : JSON.stringify({ ...old, totalSize: damage === 'invalid-shape' ? 'invalid' : 4 });
      await cache.put(getAudioMetaKey(baseKey), new Response(damaged));
      const { readStarted, settle } = gateNextRead(cache, true);
      const event = createEvent(url);
      fetchHandler(event);
      await readStarted;
      await withAudioCacheLock(baseKey, async () => {
        await seedAudio(cacheStorage, chunks, { generation: 'new' });
      });
      settle();
      const response = await respondedWith(event);
      expect(await response.text()).toBe('network');
      expect(await cache.keys()).toHaveLength(2);
    },
  );

  it('keeps a replacement when an old preflight chunk check reports a missing chunk', async () => {
    const { fetchHandler, cacheStorage, locks } = loadScript();
    vi.stubGlobal('navigator', { locks });
    const chunks = [new Uint8Array([0, 1, 2])];
    const { url, baseKey, cache } = await seedAudio(cacheStorage, chunks);
    const key = getAudioChunkKey(baseKey, 0);
    await cache.delete(key);
    const { readStarted, settle } = gateNextRead(cache, true, key);
    const event = createEvent(url);
    fetchHandler(event);
    await readStarted;
    await withAudioCacheLock(baseKey, async () => {
      await seedAudio(cacheStorage, chunks, { generation: 'new' });
    });
    settle();
    expect(await (await respondedWith(event)).text()).toBe('network');
    expect(await cache.keys()).toHaveLength(2);
  });

  it('fails damaged playback without destructive cleanup when Web Locks are unavailable', async () => {
    const { fetchHandler, cacheStorage } = loadScript({ locks: null });
    const { url, baseKey, cache } = await seedAudio(cacheStorage, [new Uint8Array([0, 1, 2])]);
    const event = createEvent(url);
    fetchHandler(event);
    const response = await respondedWith(event);
    await cache.put(getAudioChunkKey(baseKey, 0), new Response(new Uint8Array([0])));
    await expect(response.arrayBuffer()).rejects.toThrow('expected 3');
    expect(await cache.keys()).toHaveLength(2);
  });

  it('uses the network and keeps the download when the metadata body cannot be read', async () => {
    const { fetchHandler, cacheStorage } = loadScript();
    const { url, baseKey, cache } = await seedAudio(cacheStorage, [new Uint8Array([0, 1, 2])]);
    const unreadable = new ReadableStream({
      pull(controller) {
        controller.error(new Error('Cache Storage went away'));
      },
    });
    await cache.put(getAudioMetaKey(baseKey), new Response(unreadable));
    const event = createEvent(url);
    fetchHandler(event);
    expect(await (await respondedWith(event)).text()).toBe('network');
    expect(await cache.keys()).toHaveLength(2);
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

  it('preserves well-formed partial chunks while forwarding to the network', async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    const first = new Uint8Array([0, 1, 2, 3, 4]);
    const { url, baseKey, cache } = await seedAudio(cacheStorage, [first], {
      complete: false,
    });

    const event = createEvent(url, { headers: { Range: 'bytes=5-9' } });
    fetchHandler(event);
    expect(await (await respondedWith(event)).text()).toBe('network');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await cache.match(getAudioMetaKey(baseKey))).toBeDefined();
    expect(await cache.match(getAudioChunkKey(baseKey, 0))).toBeDefined();
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

  it('answers a failed normal navigation with the shell at the requested URL without caching the page', async () => {
    const { fetchHandler, fetchMock, cacheStorage } = loadScript();
    const shell = await cacheStorage.open(OFFLINE_CACHE_NAMES.shell);
    await shell.put(DOWNLOADS_PATH, new Response('<html>downloads</html>'));
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));

    const event = createEvent('/catalog/cat/event/7', { mode: 'navigate' });
    fetchHandler(event);
    const response = await respondedWith(event);

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).toContain('downloads');
    expect(response.headers.get(OFFLINE_RESPONSE_HEADER)).toBe('1');
    expect(await shell.match('/catalog/cat/event/7')).toBeUndefined();
  });

  it('does not intercept JSON API reads', () => {
    const { fetchHandler } = loadScript();
    const event = createEvent(`/api/transcript/${HASH}`);
    fetchHandler(event);
    expect(event.respondWith).not.toHaveBeenCalled();
  });
});

describe('offline build assets', () => {
  it('recognizes a Downloads iframe by its referrer', async () => {
    const { fetchHandler, cacheStorage, clientUrls } = loadScript();
    clientUrls.set('parent-client', `${ORIGIN}/catalog/cat`);

    const event = createEvent('/_next/static/chunks/downloads-frame.js', {
      clientId: 'parent-client',
      referrer: `${ORIGIN}/downloads?warm=1`,
    });
    fetchHandler(event);
    await respondedWith(event);

    const cache = await cacheStorage.open(OFFLINE_CACHE_NAMES.static);
    expect(await cache.match(event.request)).toBeDefined();
  });

  it('only adds Downloads assets and keeps the cache bounded', async () => {
    const { fetchHandler, cacheStorage, clientUrls, internals } = loadScript();
    clientUrls.set('downloads-client', `${ORIGIN}/downloads`);
    clientUrls.set('app-client', `${ORIGIN}/catalog/cat`);

    const appAsset = createEvent('/_next/static/chunks/app-only.js', {
      clientId: 'app-client',
    });
    fetchHandler(appAsset);
    await respondedWith(appAsset);

    for (
      let index = 0;
      index <= internals.STATIC_CACHE_MAX_ENTRIES;
      index += 1
    ) {
      const event = createEvent(`/_next/static/chunks/downloads-${index}.js`, {
        clientId: 'downloads-client',
      });
      fetchHandler(event);
      await respondedWith(event);
    }

    const cache = await cacheStorage.open(OFFLINE_CACHE_NAMES.static);
    const keys = await cache.keys();
    expect(keys).toHaveLength(internals.STATIC_CACHE_MAX_ENTRIES);
    expect(
      await cache.match(`${ORIGIN}/_next/static/chunks/app-only.js`),
    ).toBeUndefined();
    expect(
      await cache.match(`${ORIGIN}/_next/static/chunks/downloads-0.js`),
    ).toBeUndefined();
    expect(
      await cache.match(
        `${ORIGIN}/_next/static/chunks/downloads-${internals.STATIC_CACHE_MAX_ENTRIES}.js`,
      ),
    ).toBeDefined();
  });
});
