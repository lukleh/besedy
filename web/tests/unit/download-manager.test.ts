/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEventDetailUrl,
  buildRecordingEntryUrl,
} from '@/lib/api/recording-urls';
import {
  getAudioCacheKey,
  getAudioChunkKey,
  getAudioMetaKey,
  readAudioCacheMeta,
  writeAudioCacheMeta,
} from '@/lib/offline/audio-cache-format';
import { OFFLINE_CACHE_NAMES } from '@/lib/offline/cache-names';

const HASH = 'c'.repeat(64);
const OTHER_HASH = 'd'.repeat(64);
const CATALOG = '20260101_000000';
const CHUNK = 2 * 1024 * 1024;
const AUDIO_SIZE = CHUNK * 2 + 1234;

/** Store a complete one-chunk recording so a seeded complete record verifies. */
async function seedCompleteAudioCache(
  storage: MemoryCacheStorage,
  baseKey: string,
  size = 5,
) {
  const cache = (await storage.open(
    OFFLINE_CACHE_NAMES.audio,
  )) as unknown as Cache;
  await cache.put(
    getAudioChunkKey(baseKey, 0),
    new Response(new Uint8Array(size), {
      headers: { 'content-type': 'audio/webm' },
    }),
  );
  await writeAudioCacheMeta(cache, baseKey, {
    totalSize: size,
    chunkCount: 1,
    chunkSizes: [size],
    contentType: 'audio/webm',
    complete: true,
  });
}

class MemoryCache {
  store = new Map<string, Response>();

  private key(request: RequestInfo | URL): string {
    if (typeof request === 'string')
      return new URL(request, window.location.origin).toString();
    if (request instanceof URL) return request.toString();
    return request.url;
  }
  async match(request: RequestInfo | URL) {
    const hit = this.store.get(this.key(request));
    return hit ? hit.clone() : undefined;
  }
  async put(request: RequestInfo | URL, response: Response) {
    this.store.set(this.key(request), response);
  }
  async delete(request: RequestInfo | URL) {
    return this.store.delete(this.key(request));
  }
  async keys() {
    return Array.from(this.store.keys()).map((url) => new Request(url));
  }
}

class MemoryCacheStorage {
  caches = new Map<string, MemoryCache>();
  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.caches.set(name, cache);
    }
    return cache;
  }
  async keys() {
    return Array.from(this.caches.keys());
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
}

interface FakeServerOptions {
  /** Throw a network error when this byte offset is requested. */
  failAtOffset?: number | null;
  /** Hold this byte offset until the test explicitly rejects it. */
  deferAtOffset?: number | null;
  /** Return a mismatched Content-Range header at this byte offset. */
  invalidRangeAtOffset?: number | null;
  canViewTranscripts?: boolean;
  canDownloadTranscripts?: boolean;
  artworkStatus?: number;
}

function createFakeServer(options: FakeServerOptions = {}) {
  const audio = new Uint8Array(AUDIO_SIZE);
  for (let i = 0; i < audio.length; i += 1) audio[i] = i % 251;
  const rangeRequests: string[] = [];
  const state: {
    deferAtOffset: number | null;
    failAtOffset: number | null;
    rejectDeferred: ((error: TypeError) => void) | null;
  } = {
    deferAtOffset: options.deferAtOffset ?? null,
    failAtOffset: options.failAtOffset ?? null,
    rejectDeferred: null,
  };

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
        window.location.origin,
      );
      const pathname = url.pathname;

      if (
        pathname === buildRecordingEntryUrl(CATALOG, HASH) ||
        pathname === buildRecordingEntryUrl(CATALOG, OTHER_HASH)
      ) {
        return json({
          entry: {
            hash: HASH,
            title: 'Talk',
            artist: 'Speaker',
            duration: '01:00:00',
          },
          canViewTranscripts: options.canViewTranscripts ?? true,
          canDownloadTranscripts: options.canDownloadTranscripts ?? true,
          canEditMetadata: false,
          canDownload: true,
        });
      }
      if (pathname.endsWith('/audio/sources')) {
        return json({
          hash: HASH,
          sources: [
            {
              id: 'archived',
              label: 'Archived',
              type: 'archived',
              available: true,
            },
          ],
          defaultSource: 'archived',
        });
      }
      if (pathname === '/api/preferences/audio-source') {
        return json({ hash: HASH, sourceId: null });
      }
      if (pathname.endsWith('/progress')) {
        return json({ progress: null });
      }
      if (pathname.endsWith('/audio')) {
        const range = new Headers(init?.headers).get('Range') ?? '';
        rangeRequests.push(range);
        const match = range.match(/bytes=(\d+)-(\d+)/);
        const start = match ? Number(match[1]) : 0;
        const end = match
          ? Math.min(Number(match[2]), AUDIO_SIZE - 1)
          : AUDIO_SIZE - 1;
        if (state.failAtOffset !== null && start === state.failAtOffset) {
          throw new TypeError('Failed to fetch');
        }
        if (state.deferAtOffset !== null && start === state.deferAtOffset) {
          return await new Promise<Response>((_resolve, reject) => {
            state.rejectDeferred = reject;
          });
        }
        return new Response(audio.slice(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'audio/webm',
            'content-range':
              options.invalidRangeAtOffset === start
                ? `bytes ${start + 1}-${end}/${AUDIO_SIZE}`
                : `bytes ${start}-${end}/${AUDIO_SIZE}`,
          },
        });
      }
      if (pathname.startsWith('/api/transcript/')) {
        if (pathname.endsWith('/speakers'))
          return json({ hash: HASH, backends: [] });
        if (pathname.endsWith('/formats'))
          return json({
            hash: HASH,
            backend: 'whisperx/large',
            formats: ['json'],
          });
        if (url.searchParams.get('backend'))
          return json({ hash: HASH, backend: 'whisperx/large', segments: [] });
        return json({ hash: HASH, backends: ['whisperx/large'] });
      }
      if (pathname === buildEventDetailUrl(CATALOG, 7)) {
        return json({
          id: 7,
          workflowGroupId: CATALOG,
          title: 'Evening talk',
          location: { id: 1, name: 'Prague' },
          dateYear: 2026,
          dateMonth: 5,
          dateDay: 1,
          sessionIndex: 1,
          released: true,
          recordings: [
            {
              audioHash: OTHER_HASH,
              isPrimary: false,
              sortOrder: 1,
              title: 'B',
              artist: null,
              durationHms: null,
              verified: true,
              recorder: null,
            },
            {
              audioHash: HASH,
              isPrimary: true,
              sortOrder: 0,
              title: 'A',
              artist: null,
              durationHms: '01:00:00',
              verified: true,
              recorder: { id: 1, name: 'Zoom' },
            },
          ],
          publishedArtwork: {
            id: '4b58cb81-ad10-4b7f-98ca-f05946711b37',
            publishedAt: '2026-05-01T00:00:00.000Z',
          },
        });
      }
      if (pathname.endsWith('/artwork')) {
        if (options.artworkStatus) {
          return new Response('artwork unavailable', {
            status: options.artworkStatus,
          });
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  );

  return { fetchMock, rangeRequests, state, audio };
}

async function loadManager() {
  const mod = await import('@/lib/offline/download-manager');
  return mod;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('download manager', () => {
  let cacheStorage: MemoryCacheStorage;

  beforeEach(() => {
    vi.resetModules();
    cacheStorage = new MemoryCacheStorage();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('caches', cacheStorage);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { controller: {}, ready: Promise.resolve({}) },
    });
    // localStorage is a mock in tests/setup.ts; the manager tolerates that.
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    // A test may pin the user agent; drop the own property so the
    // prototype getter is visible again for the next test.
    Reflect.deleteProperty(navigator, 'userAgent');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not create a download until a service worker can serve it offline', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: null,
        register: vi.fn().mockRejectedValue(new Error('registration failed')),
      },
    });
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();

    await expect(
      downloadManager.enqueueRecording({ catalogId: CATALOG, hash: HASH }),
    ).rejects.toThrow('registration failed');
    expect(downloadManager.getSnapshot().records).toHaveLength(0);
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it('downloads a recording and its offline payload', async () => {
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();
    downloadManager.setUserId('user-1');

    const record = await downloadManager.enqueueRecording({
      catalogId: CATALOG,
      hash: HASH,
    });
    expect(record.status).toBe('queued');

    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'complete',
    );
    const done = downloadManager.getSnapshot().records[0];
    expect(done.progress).toBe(100);
    expect(done.totalBytes).toBe(AUDIO_SIZE);
    expect(done.bytesLoaded).toBe(AUDIO_SIZE);
    expect(done.transcriptBackend).toBe('whisperx/large');
    expect(done.userId).toBe('user-1');
    expect(done.recording?.title).toBe('Talk');

    const audioCache = await cacheStorage.open(OFFLINE_CACHE_NAMES.audio);
    const key = getAudioCacheKey(
      `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`,
      window.location.origin,
    );
    const meta = await (await audioCache.match(getAudioMetaKey(key)))!.json();
    expect(meta).toMatchObject({
      totalSize: AUDIO_SIZE,
      chunkSizes: [CHUNK, CHUNK, 1234],
      complete: true,
    });
    const chunk2 = new Uint8Array(
      await (await audioCache.match(getAudioChunkKey(key, 2)))!.arrayBuffer(),
    );
    expect(chunk2).toEqual(server.audio.slice(CHUNK * 2));
    expect(server.rangeRequests).toEqual([
      `bytes=0-${CHUNK - 1}`,
      `bytes=${CHUNK}-${CHUNK * 2 - 1}`,
      `bytes=${CHUNK * 2}-${AUDIO_SIZE - 1}`,
    ]);

    const { getDownloadBundle } = await import('@/lib/offline/downloads-db');
    const bundle = await getDownloadBundle(done.key);
    expect(bundle?.transcriptBackend).toBe('whisperx/large');
    expect(bundle?.transcript?.segments).toEqual([]);
  });

  it('does not cache transcript data without transcript-download permission', async () => {
    const server = createFakeServer({ canDownloadTranscripts: false });
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();

    await downloadManager.enqueueRecording({ catalogId: CATALOG, hash: HASH });
    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'complete',
    );

    const done = downloadManager.getSnapshot().records[0];
    expect(done.transcriptBackend).toBeNull();
    expect(
      server.fetchMock.mock.calls.some(([input]) =>
        new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
          window.location.origin,
        ).pathname.startsWith('/api/transcript/'),
      ),
    ).toBe(false);

    const { getDownloadBundle } = await import('@/lib/offline/downloads-db');
    const bundle = await getDownloadBundle(done.key);
    expect(bundle?.transcript).toBeNull();
  });

  it('stores the event and entry payloads on a package written before they were part of the bundle', async () => {
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const db = await import('@/lib/offline/downloads-db');
    const now = Date.now();
    const key = db.makeDownloadKey(CATALOG, HASH);
    await seedCompleteAudioCache(cacheStorage, 'cached-audio');
    await db.putDownload({
      key,
      catalogId: CATALOG,
      catalogLabel: null,
      hash: HASH,
      userId: 'user-1',
      eventKey: `${CATALOG}:7`,
      event: null,
      recording: null,
      audioUrl: `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`,
      audioCacheKey: 'cached-audio',
      status: 'complete',
      progress: 100,
      bytesLoaded: AUDIO_SIZE,
      totalBytes: AUDIO_SIZE,
      error: null,
      resumeOnReconnect: false,
      transcriptBackend: null,
      hasArtwork: false,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
    await db.putDownloadBundle({
      key,
      transcriptBackend: null,
      transcript: null,
      diarization: null,
      artwork: null,
      updatedAt: now,
    });

    const { downloadManager } = await loadManager();
    downloadManager.setUserId('user-1');
    await downloadManager.hydrate();
    await waitFor(async () => {
      const bundle = await db.getDownloadBundle(key);
      return bundle?.entry !== undefined && bundle?.eventDetail !== undefined;
    });

    const bundle = await db.getDownloadBundle(key);
    expect(bundle?.entry?.entry.hash).toBe(HASH);
    expect(bundle?.eventDetail?.id).toBe(7);
    expect(bundle?.eventDetail?.recordings).toHaveLength(2);
  });

  it('drops the stored speaker overlay once that permission is revoked', async () => {
    // The fake server's entry carries no canSeeSpeakers, i.e. revoked.
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const db = await import('@/lib/offline/downloads-db');
    const now = Date.now();
    const key = db.makeDownloadKey(CATALOG, HASH);
    await seedCompleteAudioCache(cacheStorage, 'cached-audio');
    await db.putDownload({
      key,
      catalogId: CATALOG,
      catalogLabel: null,
      hash: HASH,
      userId: 'user-1',
      eventKey: null,
      event: null,
      recording: null,
      audioUrl: `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`,
      audioCacheKey: 'cached-audio',
      status: 'complete',
      progress: 100,
      bytesLoaded: AUDIO_SIZE,
      totalBytes: AUDIO_SIZE,
      error: null,
      resumeOnReconnect: false,
      transcriptBackend: 'whisperx/large',
      hasArtwork: false,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
    await db.putDownloadBundle({
      key,
      transcriptBackend: 'whisperx/large',
      transcript: { backend: 'whisperx/large', segments: [] },
      diarization: { hash: HASH, model: 'pyannote', numSpeakers: 0, segments: [] },
      artwork: null,
      entry: {
        entry: {
          hash: HASH,
          hasArchived: true,
          hasMetadata: true,
          isActionable: true,
          isPublished: true,
          hasArchivedAudio: true,
          hasOriginalAudio: false,
        },
        canViewTranscripts: true,
        canEditMetadata: false,
        canDownloadAudio: true,
        canDownloadTranscripts: true,
        canSeeSpeakers: true,
      },
      updatedAt: now,
    });

    const { downloadManager } = await loadManager();
    downloadManager.setUserId('user-1');
    await downloadManager.hydrate();
    await waitFor(async () => {
      const bundle = await db.getDownloadBundle(key);
      return bundle?.diarization === null;
    });

    const bundle = await db.getDownloadBundle(key);
    expect(bundle?.entry?.canSeeSpeakers).not.toBe(true);
    // The transcript itself is still permitted and stays.
    expect(bundle?.transcript).not.toBeNull();
    expect(downloadManager.getSnapshot().records[0]?.transcriptBackend).toBe('whisperx/large');
  });

  it('resumes a download from the surviving contiguous prefix when a later chunk is missing', async () => {
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const cache = (await cacheStorage.open(OFFLINE_CACHE_NAMES.audio)) as unknown as Cache;
    const cacheKey = 'prefix-audio';
    // Chunks 0 and 1 stored, chunk 2 missing, metadata claims all three.
    for (const index of [0, 1]) {
      await cache.put(
        getAudioChunkKey(cacheKey, index),
        new Response(server.audio.slice(index * CHUNK, (index + 1) * CHUNK)),
      );
    }
    await writeAudioCacheMeta(cache, cacheKey, {
      totalSize: AUDIO_SIZE,
      chunkCount: 3,
      chunkSizes: [CHUNK, CHUNK, AUDIO_SIZE - 2 * CHUNK],
      contentType: 'audio/webm',
      complete: true,
    });

    const { downloadAudioChunks } = await loadManager();
    const total = await downloadAudioChunks({
      cache,
      url: `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`,
      cacheKey,
      signal: new AbortController().signal,
      onProgress: async () => {},
    });

    expect(total).toBe(AUDIO_SIZE);
    // Only the missing tail was fetched; the prefix stayed.
    expect(server.rangeRequests).toEqual([`bytes=${2 * CHUNK}-${AUDIO_SIZE - 1}`]);
    const meta = await readAudioCacheMeta(cache, cacheKey);
    expect(meta?.complete).toBe(true);
    expect(meta?.chunkSizes).toEqual([CHUNK, CHUNK, AUDIO_SIZE - 2 * CHUNK]);
  });

  it('resets metadata that verification would reject instead of resuming through the fast path', async () => {
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const cache = (await cacheStorage.open(OFFLINE_CACHE_NAMES.audio)) as unknown as Cache;
    const cacheKey = 'inconsistent-audio';
    for (const index of [0, 1]) {
      await cache.put(getAudioChunkKey(cacheKey, index), new Response(new Uint8Array(4)));
    }
    // Sizes total 8 bytes against a 5-byte total, yet claim completion.
    await writeAudioCacheMeta(cache, cacheKey, {
      totalSize: 5,
      chunkCount: 2,
      chunkSizes: [4, 4],
      contentType: 'audio/webm',
      complete: true,
    });

    const { downloadAudioChunks } = await loadManager();
    const total = await downloadAudioChunks({
      cache,
      url: `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`,
      cacheKey,
      signal: new AbortController().signal,
      onProgress: async () => {},
    });

    expect(total).toBe(AUDIO_SIZE);
    expect(server.rangeRequests[0]).toBe(`bytes=0-${CHUNK - 1}`);
    const meta = await readAudioCacheMeta(cache, cacheKey);
    expect(meta).toMatchObject({ totalSize: AUDIO_SIZE, complete: true });
    expect(meta?.chunkSizes).toEqual([CHUNK, CHUNK, AUDIO_SIZE - 2 * CHUNK]);
  });

  it('finishes hydration with the queue available when the cache cannot be opened on an inline-audio browser', async () => {
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36',
    });
    const db = await import('@/lib/offline/downloads-db');
    const now = Date.now();
    const key = db.makeDownloadKey(CATALOG, HASH);
    await db.putDownload({
      key,
      catalogId: CATALOG,
      catalogLabel: null,
      hash: HASH,
      userId: 'user-1',
      eventKey: null,
      event: null,
      recording: null,
      audioUrl: `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`,
      audioCacheKey: 'cached-audio',
      status: 'complete',
      progress: 100,
      bytesLoaded: AUDIO_SIZE,
      totalBytes: AUDIO_SIZE,
      error: null,
      resumeOnReconnect: false,
      transcriptBackend: null,
      hasArtwork: false,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
    vi.spyOn(cacheStorage, 'open').mockRejectedValue(new Error('storage unavailable'));

    const { downloadManager, INCOMPLETE_PACKAGE_ERROR } = await loadManager();
    await downloadManager.hydrate();

    const snapshot = downloadManager.getSnapshot();
    expect(snapshot.hydrated).toBe(true);
    expect(snapshot.supported).toBe(true);
    expect(snapshot.records[0]).toMatchObject({ status: 'error', error: INCOMPLETE_PACKAGE_ERROR });
  });

  it('fails closed when the audio cache cannot be opened during verification', async () => {
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const db = await import('@/lib/offline/downloads-db');
    const now = Date.now();
    const key = db.makeDownloadKey(CATALOG, HASH);
    await seedCompleteAudioCache(cacheStorage, 'cached-audio');
    await db.putDownload({
      key,
      catalogId: CATALOG,
      catalogLabel: null,
      hash: HASH,
      userId: 'user-1',
      eventKey: null,
      event: null,
      recording: null,
      audioUrl: `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`,
      audioCacheKey: 'cached-audio',
      status: 'complete',
      progress: 100,
      bytesLoaded: AUDIO_SIZE,
      totalBytes: AUDIO_SIZE,
      error: null,
      resumeOnReconnect: false,
      transcriptBackend: null,
      hasArtwork: false,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
    vi.spyOn(cacheStorage, 'open').mockRejectedValue(new Error('storage unavailable'));

    const { downloadManager, INCOMPLETE_PACKAGE_ERROR } = await loadManager();
    await downloadManager.hydrate();

    const record = downloadManager.getSnapshot().records[0];
    expect(record.status).toBe('error');
    expect(record.error).toBe(INCOMPLETE_PACKAGE_ERROR);
  });

  it('turns a completed record whose audio is missing from the cache into a retryable error', async () => {
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const db = await import('@/lib/offline/downloads-db');
    const now = Date.now();
    const key = db.makeDownloadKey(CATALOG, HASH);
    await db.putDownload({
      key,
      catalogId: CATALOG,
      catalogLabel: null,
      hash: HASH,
      userId: 'user-1',
      eventKey: null,
      event: null,
      recording: null,
      audioUrl: `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`,
      audioCacheKey: 'gone-audio',
      status: 'complete',
      progress: 100,
      bytesLoaded: AUDIO_SIZE,
      totalBytes: AUDIO_SIZE,
      error: null,
      resumeOnReconnect: false,
      transcriptBackend: null,
      hasArtwork: false,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });

    const { downloadManager, INCOMPLETE_PACKAGE_ERROR } = await loadManager();
    await downloadManager.hydrate();

    const record = downloadManager.getSnapshot().records[0];
    expect(record.status).toBe('error');
    expect(record.error).toBe(INCOMPLETE_PACKAGE_ERROR);
    expect(record.completedAt).toBeNull();
    expect((await db.getDownload(key))?.status).toBe('error');
  });

  it('does not resurrect a download that another tab removed while hydration verified it', async () => {
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const db = await import('@/lib/offline/downloads-db');
    const now = Date.now();
    const key = db.makeDownloadKey(CATALOG, HASH);
    await db.putDownload({
      key,
      catalogId: CATALOG,
      catalogLabel: null,
      hash: HASH,
      userId: 'user-1',
      eventKey: null,
      event: null,
      recording: null,
      audioUrl: `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`,
      audioCacheKey: 'gone-audio',
      status: 'complete',
      progress: 100,
      bytesLoaded: AUDIO_SIZE,
      totalBytes: AUDIO_SIZE,
      error: null,
      resumeOnReconnect: false,
      transcriptBackend: null,
      hasArtwork: false,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });

    // Hold the audio cache open until the other tab's removal has landed, so
    // verification observes the registry after the removal.
    let releaseCache: (() => void) | null = null;
    const originalOpen = cacheStorage.open.bind(cacheStorage);
    vi.spyOn(cacheStorage, 'open').mockImplementation(async (name: string) => {
      if (name === OFFLINE_CACHE_NAMES.audio && releaseCache === null) {
        await new Promise<void>((resolve) => {
          releaseCache = resolve;
        });
      }
      return originalOpen(name);
    });

    const { downloadManager } = await loadManager();
    const hydration = downloadManager.hydrate();
    await waitFor(() => releaseCache !== null);
    await db.deleteDownloadRecord(key);
    releaseCache!();
    await hydration;

    expect(downloadManager.getSnapshot().records).toHaveLength(0);
    expect(await db.getDownload(key)).toBeUndefined();
  });

  it('removes a previously cached transcript after permission is narrowed', async () => {
    const server = createFakeServer({ canDownloadTranscripts: false });
    vi.stubGlobal('fetch', server.fetchMock);
    const db = await import('@/lib/offline/downloads-db');
    const now = Date.now();
    const key = db.makeDownloadKey(CATALOG, HASH);
    await seedCompleteAudioCache(cacheStorage, 'cached-audio');
    await db.putDownload({
      key,
      catalogId: CATALOG,
      catalogLabel: null,
      hash: HASH,
      userId: 'user-1',
      eventKey: null,
      event: null,
      recording: null,
      audioUrl: `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`,
      audioCacheKey: 'cached-audio',
      status: 'complete',
      progress: 100,
      bytesLoaded: AUDIO_SIZE,
      totalBytes: AUDIO_SIZE,
      error: null,
      resumeOnReconnect: false,
      transcriptBackend: 'whisperx/large',
      hasArtwork: true,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
    await db.putDownloadBundle({
      key,
      transcriptBackend: 'whisperx/large',
      transcript: { backend: 'whisperx/large', segments: [] },
      diarization: {
        hash: HASH,
        model: 'pyannote',
        numSpeakers: 0,
        segments: [],
      },
      artwork: {
        blob: new Blob(['artwork'], { type: 'image/jpeg' }),
        contentType: 'image/jpeg',
        variant: 'portrait',
      },
      updatedAt: now,
    });

    const { downloadManager } = await loadManager();
    downloadManager.setUserId('user-1');
    await downloadManager.hydrate();
    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.transcriptBackend === null,
    );

    const bundle = await db.getDownloadBundle(key);
    expect(bundle).toMatchObject({
      transcriptBackend: null,
      transcript: null,
      diarization: null,
      artwork: { contentType: 'image/jpeg', variant: 'portrait' },
    });
  });

  it('resumes a network-paused download from the last stored chunk on reconnect', async () => {
    const server = createFakeServer({ failAtOffset: CHUNK * 2 });
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();

    await downloadManager.enqueueRecording({ catalogId: CATALOG, hash: HASH });
    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'paused',
    );
    const paused = downloadManager.getSnapshot().records[0];
    expect(paused.bytesLoaded).toBe(CHUNK * 2);
    expect(paused.error).toBeNull();
    expect(paused.resumeOnReconnect).toBe(true);

    server.state.failAtOffset = null;
    server.rangeRequests.length = 0;
    downloadManager.setOnline(false);
    downloadManager.setOnline(true);
    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'complete',
    );
    expect(server.rangeRequests).toEqual([
      `bytes=${CHUNK * 2}-${AUDIO_SIZE - 1}`,
    ]);
  });

  it('does not miss a reconnect while the failed request is still unwinding', async () => {
    const server = createFakeServer({ deferAtOffset: CHUNK * 2 });
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();

    await downloadManager.enqueueRecording({ catalogId: CATALOG, hash: HASH });
    await waitFor(() => server.state.rejectDeferred !== null);

    downloadManager.setOnline(false);
    downloadManager.setOnline(true);
    server.state.deferAtOffset = null;
    server.state.rejectDeferred?.(new TypeError('Failed to fetch'));

    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'complete',
    );
    expect(downloadManager.getSnapshot().records[0].resumeOnReconnect).toBe(
      false,
    );
  });

  it('records server errors as failed downloads', async () => {
    const server = createFakeServer();
    server.fetchMock.mockImplementationOnce(
      async () => new Response('denied', { status: 403 }),
    );
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();

    await downloadManager.enqueueRecording({ catalogId: CATALOG, hash: HASH });
    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'error',
    );
    expect(downloadManager.getSnapshot().records[0].error).toContain(
      'HTTP 403',
    );
  });

  it('rejects a mismatched partial-content response', async () => {
    const server = createFakeServer({ invalidRangeAtOffset: CHUNK });
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();

    await downloadManager.enqueueRecording({ catalogId: CATALOG, hash: HASH });
    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'error',
    );
    expect(downloadManager.getSnapshot().records[0].bytesLoaded).toBe(CHUNK);
  });

  it('downloads an event through its primary recording and stores its artwork payload', async () => {
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();

    const record = await downloadManager.enqueueEvent({
      catalogId: CATALOG,
      eventId: 7,
    });
    expect(record.hash).toBe(HASH);
    expect(record.event).toMatchObject({
      id: 7,
      locationName: 'Prague',
      dateYear: 2026,
    });
    expect(record.recording?.recorderName).toBe('Zoom');

    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'complete',
    );
    expect(downloadManager.getSnapshot().records[0].hasArtwork).toBe(true);
    expect(downloadManager.findEventRecord(CATALOG, 7)?.status).toBe(
      'complete',
    );

    const { getDownloadBundle } = await import('@/lib/offline/downloads-db');
    const bundle = await getDownloadBundle(record.key);
    expect(bundle?.artwork?.variant).toBe('square');
    expect(bundle?.artwork?.contentType).toBe('image/jpeg');
    // Once to choose the recording at enqueue time, once inside the job to
    // store the payload the offline event page renders from.
    expect(
      server.fetchMock.mock.calls.filter(([input]) =>
        new URL(String(input), window.location.origin).pathname.endsWith(
          `/events/7`,
        ),
      ),
    ).toHaveLength(2);
    expect(bundle?.eventDetail?.id).toBe(7);
    expect(bundle?.entry?.entry.hash).toBe(HASH);

    // A second request for the same event reuses the record instead of duplicating it.
    const again = await downloadManager.enqueueEvent({
      catalogId: CATALOG,
      eventId: 7,
    });
    expect(again.key).toBe(record.key);
    expect(downloadManager.getSnapshot().records).toHaveLength(1);
  });

  it('upgrades an existing recording download into an event download', async () => {
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();

    const recording = await downloadManager.enqueueRecording({
      catalogId: CATALOG,
      catalogLabel: 'Winter catalog',
      hash: HASH,
    });
    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'complete',
    );

    const upgraded = await downloadManager.enqueueEvent({
      catalogId: CATALOG,
      catalogLabel: 'Winter catalog',
      eventId: 7,
    });
    expect(upgraded.key).toBe(recording.key);
    expect(upgraded.event?.id).toBe(7);
    expect(upgraded.catalogLabel).toBe('Winter catalog');
    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'complete',
    );

    const done = downloadManager.getSnapshot().records[0];
    expect(done.eventKey).toBe(`${CATALOG}:7`);
    expect(done.hasArtwork).toBe(true);
    expect(downloadManager.getSnapshot().records).toHaveLength(1);
  });

  it('completes an event download when its optional artwork is unavailable', async () => {
    const server = createFakeServer({ artworkStatus: 500 });
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();

    await downloadManager.enqueueEvent({ catalogId: CATALOG, eventId: 7 });
    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'complete',
    );
    expect(downloadManager.getSnapshot().records[0].hasArtwork).toBe(false);
  });

  it('removes a download together with its cached bundle', async () => {
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();

    const record = await downloadManager.enqueueEvent({
      catalogId: CATALOG,
      eventId: 7,
    });
    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'complete',
    );

    await downloadManager.remove(record.key);
    expect(downloadManager.getSnapshot().records).toHaveLength(0);

    const audioCache = await cacheStorage.open(OFFLINE_CACHE_NAMES.audio);
    expect(await audioCache.keys()).toHaveLength(0);
    const { getDownloadBundle } = await import('@/lib/offline/downloads-db');
    expect(await getDownloadBundle(record.key)).toBeUndefined();
    // The registry stays empty after a fresh hydrate.
    vi.resetModules();
    const fresh = await loadManager();
    await fresh.downloadManager.hydrate();
    expect(fresh.downloadManager.getSnapshot().records).toHaveLength(0);
  });

  it('requeues an interrupted persisted download during hydration', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const db = await import('@/lib/offline/downloads-db');
    const now = Date.now();
    const key = db.makeDownloadKey(CATALOG, HASH);
    await db.putDownload({
      key,
      catalogId: CATALOG,
      catalogLabel: null,
      hash: HASH,
      userId: null,
      eventKey: null,
      event: null,
      recording: null,
      audioUrl: null,
      audioCacheKey: null,
      status: 'downloading',
      progress: 25,
      bytesLoaded: CHUNK,
      totalBytes: AUDIO_SIZE,
      error: null,
      resumeOnReconnect: false,
      transcriptBackend: null,
      hasArtwork: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();

    expect(downloadManager.getSnapshot().records[0]?.status).toBe('queued');
    expect((await db.getDownload(key))?.status).toBe('queued');
  });

  it("hides another user's downloads", async () => {
    const server = createFakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();
    downloadManager.setUserId('user-1');
    await downloadManager.enqueueRecording({ catalogId: CATALOG, hash: HASH });
    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'complete',
    );

    downloadManager.setUserId('user-2');
    expect(downloadManager.getSnapshot().records).toHaveLength(0);
    downloadManager.setUserId('user-1');
    expect(downloadManager.getSnapshot().records).toHaveLength(1);
  });
});
