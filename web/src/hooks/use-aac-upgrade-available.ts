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
 */
export function useAacUpgradeAvailable(record: DownloadRecord): boolean {
  const { isOnline } = useOnlineStatus();
  const enabled = isOnline && browserPrefersAacAudio() && isWebmPackage(record);
  const { data } = useQuery({
    queryKey: ["download-audio-formats", record.catalogId, record.hash],
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const response = await fetchJson<{ sources?: AudioSourceFormats[] }>(
        buildAudioSourcesUrl(record.catalogId, record.hash)
      );
      return response.sources ?? [];
    },
  });
  return enabled && !!data && hasAacCopyForPackage(record, data);
}
