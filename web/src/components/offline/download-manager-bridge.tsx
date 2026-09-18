'use client';

import { useEffect } from 'react';
import { useReloadSafety } from '@/contexts/reload-safety-context';
import { useSession } from '@/contexts/session-context';
import { useDownloadManager } from '@/hooks/use-downloads';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { getSession as getClientSession } from '@/lib/auth/client';
import { downloadManager } from '@/lib/offline/download-manager';
import {
  flushPendingPlaybackProgress,
  subscribeToPendingPlaybackProgress,
} from '@/lib/offline/playback-progress-sync';

/**
 * Connects the download manager to the React tree: hydrates the registry,
 * tracks the signed-in user and connectivity, blocks automatic app reloads
 * while a download runs, and resumes network-interrupted work on reconnect.
 */
export function DownloadManagerBridge() {
  const { session } = useSession();
  const { isOnline } = useOnlineStatus();
  const { registerBlocker } = useReloadSafety();
  const { activeKey, records } = useDownloadManager();
  const userId = session?.user?.id ?? null;

  useEffect(() => {
    void downloadManager.hydrate();
  }, []);

  useEffect(() => {
    downloadManager.setUserId(userId);
  }, [userId]);

  useEffect(() => {
    downloadManager.setOnline(isOnline);
  }, [isOnline]);

  useEffect(
    () =>
      subscribeToPendingPlaybackProgress((ownerUserId) => {
        if (navigator.onLine && userId === ownerUserId) {
          void flushPendingPlaybackProgress(userId);
        }
      }),
    [userId],
  );

  // The cached Downloads shell starts without a server-provided session. Read
  // the authenticated client session after reconnecting and use that verified
  // identity for the flush; never upload entries under an anonymous owner.
  useEffect(() => {
    if (userId || !records.some((record) => record.userId)) return;
    let cancelled = false;
    let retryTimer: number | undefined;

    const recoverSessionAndFlush = () => {
      if (!navigator.onLine) return;
      void getClientSession()
        .then(async (result) => {
          if (cancelled) return;
          const refreshedUserId = result.data?.user.id;
          if (!refreshedUserId) return;
          const flush = await flushPendingPlaybackProgress(refreshedUserId);
          if (flush.failed === 0 && retryTimer !== undefined) {
            window.clearInterval(retryTimer);
            retryTimer = undefined;
          }
        })
        .catch(() => {
          // Stay local and retry on the next reconnect/focus/timer trigger.
        });
    };

    recoverSessionAndFlush();
    window.addEventListener('online', recoverSessionAndFlush);
    window.addEventListener('focus', recoverSessionAndFlush);
    retryTimer = window.setInterval(recoverSessionAndFlush, 2_000);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearInterval(retryTimer);
      window.removeEventListener('online', recoverSessionAndFlush);
      window.removeEventListener('focus', recoverSessionAndFlush);
    };
  }, [records, userId]);

  useEffect(() => {
    if (!isOnline || !userId) return;

    const flush = () => {
      void flushPendingPlaybackProgress(userId);
    };
    const flushWhenVisible = () => {
      if (document.visibilityState === 'visible') flush();
    };

    flush();
    window.addEventListener('focus', flush);
    document.addEventListener('visibilitychange', flushWhenVisible);
    return () => {
      window.removeEventListener('focus', flush);
      document.removeEventListener('visibilitychange', flushWhenVisible);
    };
  }, [isOnline, userId]);

  useEffect(() => {
    if (!activeKey) return;
    return registerBlocker({
      id: `download:${activeKey}`,
      kind: 'download',
      blocksAutomatic: true,
      blocksManual: false,
    });
  }, [activeKey, registerBlocker]);

  return null;
}
