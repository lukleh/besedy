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
        publishedPoster: null,
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
      hasPoster: false,
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
    expect(database.version).toBe(4);
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
      poster: {
        blob: new Blob(['poster'], { type: 'image/jpeg' }),
        contentType: 'image/jpeg',
        variant: 'portrait',
      },
      updatedAt: Date.now(),
    });

    expect(await db.getDownloadBundle(key)).toMatchObject({
      key,
      transcriptBackend: 'whisperx/large',
      poster: { variant: 'portrait' },
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
