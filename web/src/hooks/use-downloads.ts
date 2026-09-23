"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  downloadManager,
  type DownloadManagerSnapshot,
  type DownloadRecord,
} from "@/lib/offline/download-manager";
import { makeDownloadKey, makeEventKey, type DownloadStatus } from "@/lib/offline/downloads-db";

interface DownloadedEventTarget {
  id: number;
  primaryAudioHash: string | null;
}

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
export function useDownloadedEvents(
  catalogId: string | null | undefined,
  events: readonly DownloadedEventTarget[] = []
): Map<number, DownloadStatus> {
  const { records } = useDownloadManager();
  return useMemo(() => {
    const result = new Map<number, DownloadStatus>();
    const statusByHash = new Map<string, DownloadStatus>();
    if (!catalogId) return result;
    const eventKeyPrefix = `${catalogId}:`;
    for (const record of records) {
      if (record.catalogId !== catalogId) continue;
      statusByHash.set(record.hash, record.status);

      // eventKey is the durable association. Event snapshots are display
      // metadata and can be absent on records written by an earlier release.
      // Do not make the catalog indicator depend on that optional payload.
      if (record.eventKey?.startsWith(eventKeyPrefix)) {
        const eventId = Number(record.eventKey.slice(eventKeyPrefix.length));
        if (Number.isSafeInteger(eventId) && eventId >= 0) {
          result.set(eventId, record.status);
          continue;
        }
      }

      if (record.event) result.set(record.event.id, record.status);
    }

    // An individual recording download is still enough to play an event that
    // uses it as its primary recording. Event-key state wins when present.
    for (const event of events) {
      if (!result.has(event.id) && event.primaryAudioHash) {
        const status = statusByHash.get(event.primaryAudioHash);
        if (status) result.set(event.id, status);
      }
    }
    return result;
  }, [records, catalogId, events]);
}
