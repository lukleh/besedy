"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useOnlineStatus } from "./use-online-status";
import { fetchJson } from "@/lib/api/fetch-json";
import { createClientLogger } from "@/lib/log/client";

const CatalogStatusSchema = z.object({
  catalogId: z.string(),
  lastModifiedAt: z.string().datetime(),
  // Count of curated AudioMetadata records (not total catalog entries)
  curatedEntries: z.number().int(),
});

type CatalogStatus = z.infer<typeof CatalogStatusSchema>;

interface UseCatalogStatusResult {
  /** Whether local data may be outdated */
  isStale: boolean;
  /** Last time we checked the server */
  lastCheckedAt: Date | null;
  /** Last time we synced data */
  lastSyncedAt: Date | null;
  /** Server's lastModifiedAt timestamp (when catalog data last changed) */
  catalogChangedAt: Date | null;
  /** Latest server status */
  serverStatus: CatalogStatus | null;
  /** Mark as synced after successful data fetch */
  markAsSynced: (serverLastModifiedAt: string) => void;
  /** Force a status check now */
  checkNow: () => Promise<void>;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOCAL_STORAGE_KEY_PREFIX = "besedy-catalog-status-";
const LOCAL_STORAGE_SYNCED_AT_PREFIX = "besedy-catalog-synced-at-";
const logger = createClientLogger("useCatalogStatus");

/**
 * Hook for polling catalog status to detect server-side changes.
 *
 * Polls every 5 minutes while the page is visible.
 * Compares server lastModifiedAt with cached value to detect staleness.
 * Does NOT auto-refresh - waits for user action (filter, page change, etc.)
 */
export function useCatalogStatus(catalogId: string | null): UseCatalogStatusResult {
  const { isOnline } = useOnlineStatus();
  const [isStale, setIsStale] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [catalogChangedAt, setCatalogChangedAt] = useState<Date | null>(null);
  const [serverStatus, setServerStatus] = useState<CatalogStatus | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cachedTimestampRef = useRef<string | null>(null);

  // Reset and hydrate catalog-specific state when catalog changes.
  // Kept in a single effect to avoid load/reset race conditions.
  useEffect(() => {
    cachedTimestampRef.current = null;

    queueMicrotask(() => {
      setIsStale(false);
      setServerStatus(null);
      setLastCheckedAt(null);
      setLastSyncedAt(null);
      setCatalogChangedAt(null);

      // SSR guard - localStorage only available in browser
      if (!catalogId || typeof window === "undefined") return;

      const key = `${LOCAL_STORAGE_KEY_PREFIX}${catalogId}`;
      const cached = localStorage.getItem(key);
      if (cached) {
        cachedTimestampRef.current = cached;
        setCatalogChangedAt(new Date(cached));
      }

      const syncedAtKey = `${LOCAL_STORAGE_SYNCED_AT_PREFIX}${catalogId}`;
      const syncedAt = localStorage.getItem(syncedAtKey);
      if (syncedAt) {
        setLastSyncedAt(new Date(syncedAt));
      }
    });
  }, [catalogId]);

  // Check server status
  const checkStatus = useCallback(async () => {
    if (!catalogId || !isOnline) return;

    try {
      const status = await fetchJson<CatalogStatus>(
        `/api/catalogs/${catalogId}/status`,
        { schema: CatalogStatusSchema }
      );
      setServerStatus(status);
      setLastCheckedAt(new Date());

      // Compare with cached value
      if (cachedTimestampRef.current) {
        const serverTime = new Date(status.lastModifiedAt).getTime();
        const cachedTime = new Date(cachedTimestampRef.current).getTime();
        setIsStale(serverTime > cachedTime);
      } else {
        // No cached timestamp yet - not stale, but save the current one
        setIsStale(false);
        cachedTimestampRef.current = status.lastModifiedAt;
        const key = `${LOCAL_STORAGE_KEY_PREFIX}${catalogId}`;
        localStorage.setItem(key, status.lastModifiedAt);
      }
    } catch (error) {
      logger.error("Failed to check status", error);
    }
  }, [catalogId, isOnline]);

  // Mark as synced after successful data fetch
  const markAsSynced = useCallback(
    (serverLastModifiedAt: string) => {
      if (!catalogId) return;

      const now = new Date();
      cachedTimestampRef.current = serverLastModifiedAt;

      // Save the catalog's lastModifiedAt
      const key = `${LOCAL_STORAGE_KEY_PREFIX}${catalogId}`;
      localStorage.setItem(key, serverLastModifiedAt);
      setCatalogChangedAt(new Date(serverLastModifiedAt));

      // Save when we synced
      const syncedAtKey = `${LOCAL_STORAGE_SYNCED_AT_PREFIX}${catalogId}`;
      localStorage.setItem(syncedAtKey, now.toISOString());
      setLastSyncedAt(now);

      setIsStale(false);
    },
    [catalogId]
  );

  // Polling with Page Visibility API
  useEffect(() => {
    if (!catalogId) return;

    const startPolling = () => {
      if (intervalRef.current) return;
      intervalRef.current = setInterval(checkStatus, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        // Check immediately when page becomes visible
        queueMicrotask(() => checkStatus());
        startPolling();
      }
    };

    // Initial check
    queueMicrotask(() => checkStatus());

    // Start polling if page is visible
    if (!document.hidden) {
      startPolling();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [catalogId, checkStatus]);

  return {
    isStale,
    lastCheckedAt,
    lastSyncedAt,
    catalogChangedAt,
    serverStatus,
    markAsSynced,
    checkNow: checkStatus,
  };
}
