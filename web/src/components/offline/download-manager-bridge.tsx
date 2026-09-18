"use client";

import { useEffect, useRef } from "react";
import { useReloadSafety } from "@/contexts/reload-safety-context";
import { useSession } from "@/contexts/session-context";
import { useServiceWorker } from "@/contexts/service-worker-context";
import { useDownloadManager } from "@/hooks/use-downloads";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { downloadManager } from "@/lib/offline/download-manager";

const SHELL_WARMED_KEY = "besedy-downloads-shell-warmed";

/**
 * Connects the download manager to the React tree: hydrates the registry,
 * tracks the signed-in user and connectivity, blocks automatic app reloads
 * while a download runs, and caches the Downloads page once per session so an
 * offline start has somewhere to land.
 */
export function DownloadManagerBridge() {
  const { session } = useSession();
  const { isOnline } = useOnlineStatus();
  const { isReady } = useServiceWorker();
  const { registerBlocker } = useReloadSafety();
  const { activeKey, supported, hydrated } = useDownloadManager();
  const warmedRef = useRef(false);
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
      kind: "download",
      blocksAutomatic: true,
      blocksManual: false,
    });
  }, [activeKey, registerBlocker]);

  useEffect(() => {
    if (!supported || !hydrated || !isReady || !isOnline || !userId || warmedRef.current) return;
    try {
      if (window.sessionStorage.getItem(SHELL_WARMED_KEY) === "1") {
        warmedRef.current = true;
        return;
      }
    } catch {
      // sessionStorage may be unavailable; warm anyway.
    }
    warmedRef.current = true;
    void downloadManager.warmShell().then(() => {
      try {
        window.sessionStorage.setItem(SHELL_WARMED_KEY, "1");
      } catch {
        // Ignore storage failures.
      }
    });
  }, [supported, hydrated, isReady, isOnline, userId]);

  return null;
}
