/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/fetch-json';

const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));

vi.mock('@/lib/api/fetch-json', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/fetch-json')>()),
  fetchJson,
}));
vi.mock('@/lib/log/client', () => ({
  createClientLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

const HASH = 'f'.repeat(64);
const INPUT = {
  userId: 'u1',
  catalogId: 'cat',
  hash: HASH,
  durationSec: 120,
  completed: false,
};

async function loadModules() {
  const sync = await import('@/lib/offline/playback-progress-sync');
  const db = await import('@/lib/offline/downloads-db');
  return { db, sync };
}

describe('offline playback progress sync', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchJson.mockReset();
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('coalesces changes and syncs a backward seek as authoritative', async () => {
    fetchJson.mockResolvedValue({});
    const { db, sync } = await loadModules();
    await sync.queuePlaybackProgress({ ...INPUT, positionSec: 80 });
    await sync.queuePlaybackProgress({ ...INPUT, positionSec: 20 });

    await expect(sync.flushPendingPlaybackProgress('u1')).resolves.toEqual({
      attempted: 1,
      synced: 1,
      discarded: 0,
      failed: 0,
    });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).toHaveBeenCalledWith(
      `/api/catalogs/cat/recordings/${HASH}/progress`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          positionSec: 20,
          durationSec: 120,
          completed: false,
        }),
      }),
    );
    expect(await db.listPendingPlaybackProgress('u1')).toEqual([]);
  });

  it('retains failed updates and retries them later', async () => {
    fetchJson.mockRejectedValueOnce(new TypeError('offline'));
    const { db, sync } = await loadModules();
    await sync.queuePlaybackProgress({ ...INPUT, positionSec: 35 });

    await expect(sync.flushPendingPlaybackProgress('u1')).resolves.toEqual({
      attempted: 1,
      synced: 0,
      discarded: 0,
      failed: 1,
    });
    expect(await db.listPendingPlaybackProgress('u1')).toHaveLength(1);

    fetchJson.mockResolvedValueOnce({});
    await expect(sync.flushPendingPlaybackProgress('u1')).resolves.toEqual({
      attempted: 1,
      synced: 1,
      discarded: 0,
      failed: 0,
    });
    expect(await db.listPendingPlaybackProgress('u1')).toEqual([]);
  });

  it('discards a revision rejected by a terminal client error', async () => {
    fetchJson.mockRejectedValueOnce(new ApiError('Not found', 404));
    const { db, sync } = await loadModules();
    await sync.queuePlaybackProgress({ ...INPUT, positionSec: 35 });

    await expect(sync.flushPendingPlaybackProgress('u1')).resolves.toEqual({
      attempted: 1,
      synced: 0,
      discarded: 1,
      failed: 0,
    });
    expect(await db.listPendingPlaybackProgress('u1')).toEqual([]);
  });

  it.each([401, 408, 429, 500])(
    'retains a revision rejected with retryable status %s',
    async (status) => {
      fetchJson.mockRejectedValueOnce(new ApiError('Retry later', status));
      const { db, sync } = await loadModules();
      await sync.queuePlaybackProgress({ ...INPUT, positionSec: 35 });

      await expect(sync.flushPendingPlaybackProgress('u1')).resolves.toEqual({
        attempted: 1,
        synced: 0,
        discarded: 0,
        failed: 1,
      });
      expect(await db.listPendingPlaybackProgress('u1')).toHaveLength(1);
    },
  );

  it('does not discard a newer revision after a terminal response', async () => {
    let rejectRequest: ((error: ApiError) => void) | undefined;
    fetchJson
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectRequest = reject;
          }),
      )
      .mockRejectedValueOnce(new TypeError('offline'));
    const { db, sync } = await loadModules();
    await sync.queuePlaybackProgress({ ...INPUT, positionSec: 10 });

    const flush = sync.flushPendingPlaybackProgress('u1');
    await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));
    await sync.queuePlaybackProgress({ ...INPUT, positionSec: 45 });
    rejectRequest?.(new ApiError('Not found', 404));

    await expect(flush).resolves.toEqual({
      attempted: 2,
      synced: 0,
      discarded: 0,
      failed: 1,
    });
    expect(await db.listPendingPlaybackProgress('u1')).toEqual([
      expect.objectContaining({ positionSec: 45 }),
    ]);
  });

  it('sends a newer update queued during an in-flight sync', async () => {
    let finishRequest: (() => void) | undefined;
    fetchJson.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRequest = resolve;
        }),
    );
    const { db, sync } = await loadModules();
    await sync.queuePlaybackProgress({ ...INPUT, positionSec: 10 });

    const flush = sync.flushPendingPlaybackProgress('u1');
    await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));
    await sync.queuePlaybackProgress({ ...INPUT, positionSec: 45 });
    finishRequest?.();
    await expect(flush).resolves.toEqual({
      attempted: 2,
      synced: 1,
      discarded: 0,
      failed: 0,
    });

    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchJson.mock.calls[1]?.[1]?.body))).toMatchObject({
      positionSec: 45,
    });
    expect(await db.listPendingPlaybackProgress('u1')).toEqual([]);
  });
});
