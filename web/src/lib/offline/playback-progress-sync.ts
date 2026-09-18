'use client';

import { fetchJson } from '@/lib/api/fetch-json';
import { buildPlaybackProgressUrl } from '@/lib/api/recording-urls';
import { createClientLogger } from '@/lib/log/client';
import {
  deletePendingPlaybackProgress,
  listPendingPlaybackProgress,
  putPendingPlaybackProgress,
  type PendingPlaybackProgressInput,
} from '@/lib/offline/downloads-db';

const logger = createClientLogger('playbackProgressSync');

export interface PlaybackProgressFlushResult {
  attempted: number;
  synced: number;
  failed: number;
}

const activeFlushes = new Map<string, Promise<PlaybackProgressFlushResult>>();
const rerunRequested = new Set<string>();
const pendingListeners = new Set<(userId: string) => void>();

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export async function queuePlaybackProgress(
  input: PendingPlaybackProgressInput,
): Promise<void> {
  const durationSec =
    input.durationSec !== null &&
    Number.isFinite(input.durationSec) &&
    input.durationSec > 0
      ? input.durationSec
      : null;
  await putPendingPlaybackProgress({
    ...input,
    positionSec: finiteNonNegative(input.positionSec),
    durationSec,
  });
  for (const listener of pendingListeners) listener(input.userId);
}

export function subscribeToPendingPlaybackProgress(
  listener: (userId: string) => void,
): () => void {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

async function runFlush(userId: string): Promise<PlaybackProgressFlushResult> {
  let pending;
  try {
    pending = await listPendingPlaybackProgress(userId);
  } catch (error) {
    logger.warn('Failed to read pending playback progress', { error });
    return { attempted: 0, synced: 0, failed: 1 };
  }

  const result: PlaybackProgressFlushResult = {
    attempted: pending.length,
    synced: 0,
    failed: 0,
  };

  await Promise.all(
    pending.map(async (entry) => {
      try {
        await fetchJson(buildPlaybackProgressUrl(entry.catalogId, entry.hash), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            positionSec: entry.positionSec,
            durationSec: entry.durationSec,
            completed: entry.completed,
          }),
        });
        const deleted = await deletePendingPlaybackProgress(
          entry.key,
          entry.revision,
        );
        if (deleted) {
          result.synced += 1;
        } else {
          // Playback changed while this request was in flight. Send the newer
          // revision in another pass instead of waiting for a future focus.
          rerunRequested.add(userId);
        }
      } catch (error) {
        result.failed += 1;
        logger.warn('Playback progress sync deferred', {
          catalogId: entry.catalogId,
          hash: entry.hash,
          error,
        });
      }
    }),
  );

  return result;
}

/**
 * Flush the latest coalesced playback state for this user. Concurrent triggers
 * share one run; a newer revision remains queued for the next trigger.
 */
export function flushPendingPlaybackProgress(
  userId: string,
): Promise<PlaybackProgressFlushResult> {
  const active = activeFlushes.get(userId);
  if (active) {
    rerunRequested.add(userId);
    return active;
  }

  const flush = (async () => {
    const total = { attempted: 0, synced: 0, failed: 0 };
    do {
      rerunRequested.delete(userId);
      const pass = await runFlush(userId);
      total.attempted += pass.attempted;
      total.synced += pass.synced;
      total.failed += pass.failed;
    } while (rerunRequested.delete(userId));
    return total;
  })().finally(() => {
    activeFlushes.delete(userId);
    // A trigger can arrive after the loop condition but before cleanup.
    if (rerunRequested.delete(userId)) {
      void flushPendingPlaybackProgress(userId);
    }
  });
  activeFlushes.set(userId, flush);
  return flush;
}
