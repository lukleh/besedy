"use client";

import { useQuery } from "@tanstack/react-query";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { fetchJson } from "@/lib/api/fetch-json";
import { buildAudioSourcesUrl } from "@/lib/api/recording-urls";
import { browserPrefersAacAudio } from "@/lib/audio-format";
import {
  hasAacCopyForPackage,
  isWebmPackage,
  type AudioSourceFormats,
} from "@/lib/offline/audio-format-upgrade";
import type { DownloadRecord } from "@/lib/offline/downloads-db";

/**
 * True when this WebKit browser holds a WebM package of a source that now has
 * the AAC copy, so downloading it again lets the whole recording play offline.
 * Checked only while online, since a new download needs the network anyway.
 *
 * The Downloads page works without a session, so a failed check (an expired
 * session's 401 included) only means no flag: it never redirects to sign-in.
 */
export function useAacUpgradeAvailable(record: DownloadRecord | null | undefined): boolean {
  const { isOnline } = useOnlineStatus();
  const enabled = !!record && isOnline && browserPrefersAacAudio() && isWebmPackage(record);
  const { data } = useQuery({
    queryKey: ["download-audio-formats", record?.catalogId ?? null, record?.hash ?? null],
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async (): Promise<AudioSourceFormats[]> => {
      if (!record) return [];
      try {
        const response = await fetchJson<{ sources?: AudioSourceFormats[] }>(
          buildAudioSourcesUrl(record.catalogId, record.hash),
          { skipAuthCheck: true }
        );
        return response.sources ?? [];
      } catch {
        return [];
      }
    },
  });
  return enabled && !!record && !!data && hasAacCopyForPackage(record, data);
}
