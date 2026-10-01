/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HASH = 'e'.repeat(64);

async function loadDb() {
  return import('@/lib/offline/downloads-db');
}

describe('downloads database', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores, lists, and deletes records', async () => {
    const db = await loadDb();
    const now = Date.now();
    await db.putDownload({
      key: db.makeDownloadKey('cat', HASH),
      catalogId: 'cat',
      catalogLabel: 'Catalog label',
      hash: HASH,
      userId: 'u1',
      eventKey: db.makeEventKey('cat', 3),
      event: {
        id: 3,
        title: null,
        locationName: 'Brno',
        dateYear: 2026,
        dateMonth: null,
        dateDay: null,
        sessionIndex: 1,
        publishedArtwork: null,
      },
      recording: null,
      audioUrl: null,
      audioCacheKey: null,
      status: 'queued',
      progress: 0,
      bytesLoaded: 0,
      totalBytes: 0,
      error: null,
      resumeOnReconnect: false,
      transcriptBackend: null,
      hasArtwork: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    const listed = await db.listDownloads();
    expect(listed).toHaveLength(1);
    expect(listed[0].eventKey).toBe('cat:3');
    expect(await db.getDownload('cat:' + HASH)).toMatchObject({
      status: 'queued',
    });

    await db.deleteDownloadRecord('cat:' + HASH);
    expect(await db.listDownloads()).toHaveLength(0);
  });

  it('drops the stores of the earlier catalog-mirror schema on upgrade', async () => {
    const legacy = indexedDB.open('besedy-offline', 1);
    await new Promise<void>((resolve, reject) => {
      legacy.onupgradeneeded = () => {
        const database = legacy.result;
        database.createObjectStore('catalogEntries', {
          keyPath: ['catalogId', 'hash'],
        });
        database.createObjectStore('catalogs', { keyPath: 'id' });
        database.createObjectStore('contentCache', { keyPath: 'hash' });
        database.createObjectStore('syncMeta', { keyPath: 'key' });
      };
      legacy.onsuccess = () => {
        legacy.result.close();
        resolve();
      };
      legacy.onerror = () => reject(legacy.error);
    });

    const db = await loadDb();
    const database = await db.getDownloadsDB();
    expect(Array.from(database.objectStoreNames)).toEqual([
      'downloadBundles',
      'downloads',
      'pendingPlaybackProgress',
    ]);
    expect(database.version).toBe(6);
  });

  it('rewrites pre-rename poster field names on already-downloaded records', async () => {
    const legacyKey = 'cat:' + HASH;
    const legacy = indexedDB.open('besedy-offline', 4);
    await new Promise<void>((resolve, reject) => {
      legacy.onupgradeneeded = () => {
        const database = legacy.result;
        const downloads = database.createObjectStore('downloads', { keyPath: 'key' });
        downloads.createIndex('byCatalog', 'catalogId');
        downloads.createIndex('byEventKey', 'eventKey');
        downloads.createIndex('byStatus', 'status');
        database.createObjectStore('downloadBundles', { keyPath: 'key' });
        const progress = database.createObjectStore('pendingPlaybackProgress', { keyPath: 'key' });
        progress.createIndex('byUser', 'userId');
      };
      legacy.onsuccess = () => {
        const database = legacy.result;
        const tx = database.transaction(['downloads', 'downloadBundles'], 'readwrite');
        tx.objectStore('downloads').put({
          key: legacyKey,
          catalogId: 'cat',
          catalogLabel: null,
          hash: HASH,
          userId: 'u1',
          eventKey: 'cat:3',
          event: {
            id: 3,
            title: null,
            locationName: null,
            dateYear: 2026,
            dateMonth: null,
            dateDay: null,
            sessionIndex: 1,
            publishedPoster: { id: 'p1', publishedAt: '2026-09-19T00:00:00Z' },
          },
          recording: null,
          audioUrl: null,
          audioCacheKey: null,
          status: 'complete',
          progress: 100,
          bytesLoaded: 10,
          totalBytes: 10,
          error: null,
          resumeOnReconnect: false,
          transcriptBackend: null,
          hasPoster: true,
          createdAt: 0,
          updatedAt: 0,
          completedAt: 0,
        });
        tx.objectStore('downloadBundles').put({
          key: legacyKey,
          transcriptBackend: null,
          transcript: null,
          diarization: null,
          poster: { blob: new Blob(['x']), contentType: 'image/jpeg', variant: 'square', posterId: 'p1' },
          updatedAt: 0,
        });
        tx.oncomplete = () => {
          database.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      legacy.onerror = () => reject(legacy.error);
    });

    const db = await loadDb();
    const record = await db.getDownload(legacyKey);
    expect(record).toMatchObject({ hasArtwork: true });
    expect((record?.event as { publishedArtwork?: unknown } | null)?.publishedArtwork).toEqual({
      id: 'p1',
      publishedAt: '2026-09-19T00:00:00Z',
    });
    expect(record).not.toHaveProperty('hasPoster');

    const bundle = await db.getDownloadBundle(legacyKey);
    expect(bundle?.artwork).toMatchObject({ contentType: 'image/jpeg', variant: 'square', artworkId: 'p1' });
    expect(bundle).not.toHaveProperty('poster');
  });

  it('deletes stored inline audio copies and recovers packages stuck on the inline error', async () => {
    const complete = 'cat:' + HASH;
    const stuck = 'cat:' + 'f'.repeat(64);
    const legacy = indexedDB.open('besedy-offline', 5);
    const record = (key: string, status: string, error: string | null) => ({
      key,
      catalogId: 'cat',
      catalogLabel: null,
      hash: key.slice(4),
      userId: 'u1',
      eventKey: null,
      event: null,
      recording: null,
      audioUrl: `/api/catalogs/cat/recordings/${key.slice(4)}/audio`,
      audioCacheKey: `https://besedy.test/api/catalogs/cat/recordings/${key.slice(4)}/audio`,
      status,
      progress: status === 'complete' ? 100 : 0,
      bytesLoaded: 10,
      totalBytes: 10,
      error,
      resumeOnReconnect: false,
      transcriptBackend: null,
      hasArtwork: false,
      createdAt: 0,
      updatedAt: 42,
      completedAt: status === 'complete' ? 42 : null,
    });
    await new Promise<void>((resolve, reject) => {
      legacy.onupgradeneeded = () => {
        const database = legacy.result;
        const downloads = database.createObjectStore('downloads', { keyPath: 'key' });
        downloads.createIndex('byCatalog', 'catalogId');
        downloads.createIndex('byEventKey', 'eventKey');
        downloads.createIndex('byStatus', 'status');
        database.createObjectStore('downloadBundles', { keyPath: 'key' });
        const progress = database.createObjectStore('pendingPlaybackProgress', { keyPath: 'key' });
        progress.createIndex('byUser', 'userId');
      };
      legacy.onsuccess = () => {
        const database = legacy.result;
        const tx = database.transaction(['downloads', 'downloadBundles'], 'readwrite');
        tx.objectStore('downloads').put(record(complete, 'complete', null));
        tx.objectStore('downloads').put(record(stuck, 'error', 'inline-audio-unavailable'));
        for (const key of [complete, stuck]) {
          tx.objectStore('downloadBundles').put({
            key,
            transcriptBackend: 'whisperx/large',
            transcript: null,
            diarization: null,
            artwork: null,
            inlineAudio: { data: new Uint8Array(10).buffer, contentType: 'audio/webm' },
            updatedAt: 0,
          });
        }
        tx.oncomplete = () => {
          database.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      legacy.onerror = () => reject(legacy.error);
    });

    const db = await loadDb();
    for (const key of [complete, stuck]) {
      const bundle = await db.getDownloadBundle(key);
      expect(bundle).not.toHaveProperty('inlineAudio');
      expect(bundle?.transcriptBackend).toBe('whisperx/large');
    }
    expect(await db.getDownload(complete)).toMatchObject({ status: 'complete', error: null });
    // Its chunks verified before; hydration checks them again as for any package.
    expect(await db.getDownload(stuck)).toMatchObject({
      status: 'complete',
      error: null,
      progress: 100,
      completedAt: 42,
    });
  });

  it('keeps large payloads separate from lightweight registry rows', async () => {
    const db = await loadDb();
    const key = db.makeDownloadKey('cat', HASH);
    await db.putDownloadBundle({
      key,
      transcriptBackend: 'whisperx/large',
      transcript: {
        backend: 'whisperx/large',
        segments: [{ start: 0, end: 1, text: 'Hello' }],
      },
      diarization: null,
      artwork: {
        blob: new Blob(['artwork'], { type: 'image/jpeg' }),
        contentType: 'image/jpeg',
        variant: 'portrait',
      },
      updatedAt: Date.now(),
    });

    expect(await db.getDownloadBundle(key)).toMatchObject({
      key,
      transcriptBackend: 'whisperx/large',
      artwork: { variant: 'portrait' },
    });
    await db.deleteDownloadBundle(key);
    expect(await db.getDownloadBundle(key)).toBeUndefined();
  });

  it('can destroy the database entirely', async () => {
    const db = await loadDb();
    await db.getDownloadsDB();
    await db.destroyDownloadsDatabase();
    const databases = await indexedDB.databases();
    expect(
      databases.find((entry) => entry.name === db.DOWNLOADS_DB_NAME),
    ).toBeUndefined();
  });

  it('coalesces pending playback progress and only deletes a synced revision', async () => {
    const db = await loadDb();
    const input = {
      userId: 'u1',
      catalogId: 'cat',
      hash: HASH,
      durationSec: 120,
      completed: false,
    };
    const first = await db.putPendingPlaybackProgress({
      ...input,
      positionSec: 80,
    });
    const backwardSeek = await db.putPendingPlaybackProgress({
      ...input,
      positionSec: 20,
    });

    expect(backwardSeek.revision).toBe(first.revision + 1);
    expect(await db.listPendingPlaybackProgress('u1')).toEqual([
      expect.objectContaining({ positionSec: 20 }),
    ]);
    expect(
      await db.deletePendingPlaybackProgress(first.key, first.revision),
    ).toBe(false);
    expect(await db.getPendingPlaybackProgress('u1', 'cat', HASH)).toEqual(
      expect.objectContaining({ positionSec: 20 }),
    );
    expect(
      await db.deletePendingPlaybackProgress(
        backwardSeek.key,
        backwardSeek.revision,
      ),
    ).toBe(true);
    expect(
      await db.getPendingPlaybackProgress('u1', 'cat', HASH),
    ).toBeUndefined();
  });
});
