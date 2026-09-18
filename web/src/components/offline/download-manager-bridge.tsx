'use client';

import { useEffect } from 'react';
import { useReloadSafety } from '@/contexts/reload-safety-context';
import { useSession } from '@/contexts/session-context';
import { useDownloadManager } from '@/hooks/use-downloads';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { downloadManager } from '@/lib/offline/download-manager';

/**
 * Connects the download manager to the React tree: hydrates the registry,
 * tracks the signed-in user and connectivity, blocks automatic app reloads
 * while a download runs, and resumes network-interrupted work on reconnect.
 */
export function DownloadManagerBridge() {
  const { session } = useSession();
  const { isOnline } = useOnlineStatus();
  const { registerBlocker } = useReloadSafety();
  const { activeKey } = useDownloadManager();
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
