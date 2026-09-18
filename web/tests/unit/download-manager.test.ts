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
} from '@/lib/offline/audio-cache-format';
import { OFFLINE_CACHE_NAMES } from '@/lib/offline/cache-names';

const HASH = 'c'.repeat(64);
const OTHER_HASH = 'd'.repeat(64);
const CATALOG = '20260101_000000';
const CHUNK = 2 * 1024 * 1024;
const AUDIO_SIZE = CHUNK * 2 + 1234;

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
  posterStatus?: number;
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
          posterFiles: {
            portrait: {
              exists: true,
              filename: 'p.jpg',
              uploadedAt: '2026-05-01T00:00:00.000Z',
            },
            landscape: { exists: false, filename: null },
          },
        });
      }
      if (pathname.endsWith('/poster')) {
        if (options.posterStatus) {
          return new Response('poster unavailable', {
            status: options.posterStatus,
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

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const started = Date.now();
  while (!predicate()) {
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
    // localStorage is a mock in tests/setup.ts; the manager tolerates that.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it('downloads an event through its primary recording and stores its poster payload', async () => {
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
    expect(downloadManager.getSnapshot().records[0].hasPoster).toBe(true);
    expect(downloadManager.findEventRecord(CATALOG, 7)?.status).toBe(
      'complete',
    );

    const { getDownloadBundle } = await import('@/lib/offline/downloads-db');
    const bundle = await getDownloadBundle(record.key);
    expect(bundle?.poster?.variant).toBe('portrait');
    expect(bundle?.poster?.contentType).toBe('image/jpeg');
    expect(
      server.fetchMock.mock.calls.filter(([input]) =>
        new URL(String(input), window.location.origin).pathname.endsWith(
          `/events/7`,
        ),
      ),
    ).toHaveLength(1);

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
    expect(done.hasPoster).toBe(true);
    expect(downloadManager.getSnapshot().records).toHaveLength(1);
  });

  it('completes an event download when its optional poster is unavailable', async () => {
    const server = createFakeServer({ posterStatus: 500 });
    vi.stubGlobal('fetch', server.fetchMock);
    const { downloadManager } = await loadManager();
    await downloadManager.hydrate();

    await downloadManager.enqueueEvent({ catalogId: CATALOG, eventId: 7 });
    await waitFor(
      () => downloadManager.getSnapshot().records[0]?.status === 'complete',
    );
    expect(downloadManager.getSnapshot().records[0].hasPoster).toBe(false);
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
      hasPoster: false,
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
