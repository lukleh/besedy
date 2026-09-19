"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  downloadManager,
  type DownloadManagerSnapshot,
  type DownloadRecord,
} from "@/lib/offline/download-manager";
import { makeDownloadKey, makeEventKey, type DownloadStatus } from "@/lib/offline/downloads-db";

/** Live view of the download registry. */
export function useDownloadManager(): DownloadManagerSnapshot {
  return useSyncExternalStore(
    downloadManager.subscribe,
    downloadManager.getSnapshot,
    downloadManager.getServerSnapshot
  );
}

/** The download record for one recording, if any. */
export function useDownloadRecord(
  catalogId: string | null | undefined,
  hash: string | null | undefined
): DownloadRecord | null {
  const { records } = useDownloadManager();
  return useMemo(() => {
    if (!catalogId || !hash) return null;
    const key = makeDownloadKey(catalogId, hash);
    return records.find((record) => record.key === key) ?? null;
  }, [records, catalogId, hash]);
}

/** The download record attached to an event, if any. */
export function useEventDownload(
  catalogId: string | null | undefined,
  eventId: number | null | undefined
): DownloadRecord | null {
  const { records } = useDownloadManager();
  return useMemo(() => {
    if (!catalogId || eventId === null || eventId === undefined) return null;
    const eventKey = makeEventKey(catalogId, eventId);
    return records.find((record) => record.eventKey === eventKey) ?? null;
  }, [records, catalogId, eventId]);
}

/** Map of eventId to download status for every downloaded event in a catalog. */
export function useDownloadedEvents(catalogId: string | null | undefined): Map<number, DownloadStatus> {
  const { records } = useDownloadManager();
  return useMemo(() => {
    const result = new Map<number, DownloadStatus>();
    if (!catalogId) return result;
    for (const record of records) {
      if (record.catalogId === catalogId && record.event) {
        result.set(record.event.id, record.status);
      }
    }
    return result;
  }, [records, catalogId]);
}
