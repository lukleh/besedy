"use client";

/**
 * Hooks that resolve media from a completed download package for the shared
 * event and recording pages. Pages stay unaware of caches and storage
 * formats; they receive a `src` and use it.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDownloadRecord, useEventDownload } from "@/hooks/use-downloads";
import { useOnlineStatus } from "@/hooks/use-online-status";
import {
  getAudioCacheKey,
  withoutAudioFormat,
} from "@/lib/offline/audio-cache-format";
import { getDownloadBundle } from "@/lib/offline/downloads-db";

/**
 * The URL the player uses for a complete local recording. It differs from the
 * network URL only by a marker the worker and the server ignore, so the
 * browser treats the switch to local playback as a new media resource
 * instead of resuming a network stream that may have died.
 */
export function localAudioSrc(audioUrl: string): string {
  return `${audioUrl}${audioUrl.includes("?") ? "&" : "?"}local=1`;
}

/**
 * An object URL that lives exactly as long as `blob` is the current value.
 * Created and revoked in an effect so a render React discards (Strict Mode,
 * an interrupted render) never leaks a URL, and a change of `blob` revokes
 * the previous one.
 */
function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [entry, setEntry] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    // The URL belongs to the committed blob; it cannot be derived in render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEntry({ blob, url });
    return () => {
      URL.revokeObjectURL(url);
      // Drop the reference so the Blob can be collected once it is unused.
      setEntry((current) => (current?.url === url ? null : current));
    };
  }, [blob]);
  // Never report a URL for a blob other than the current one, not even for
  // the render between a change of `blob` and the effect that follows it.
  return entry && entry.blob === blob ? entry.url : null;
}

/**
 * Prefer a complete local recording over the network.
 *
 * The bytes are identical by hash, playback starts without a connection, and
 * losing connectivity mid-play stops being a special case. A downloaded
 * variant that differs from the listener's current source selection is used
 * only when that selection cannot be honoured: source metadata is unknown or
 * the browser is offline.
 */
export function useLocalAudioSrc(
  catalogId: string,
  hash: string,
  selectedUrl: string,
  sourcesKnown: boolean
): string | null {
  const record = useDownloadRecord(catalogId, hash);
  const { isOnline } = useOnlineStatus();
  const complete = record?.status === "complete" && !!record.audioUrl;
  const recordCacheKey = record?.audioCacheKey;
  const matchesSelection = useMemo(() => {
    if (!complete || !recordCacheKey || typeof window === "undefined") {
      return false;
    }
    // A download of the same source in the other format still matches: a
    // WebM package made before the AAC copy existed keeps playing as it did,
    // rather than the page streaming the copy while a service worker from the
    // previous release answers that request with the WebM package.
    return (
      withoutAudioFormat(getAudioCacheKey(selectedUrl, window.location.origin)) ===
      withoutAudioFormat(recordCacheKey)
    );
  }, [complete, recordCacheKey, selectedUrl]);
  const useLocal = complete && (matchesSelection || !sourcesKnown || !isOnline);
  return useLocal && record?.audioUrl ? localAudioSrc(record.audioUrl) : null;
}

/**
 * Object URL for the artwork stored with a downloaded event. The shared event
 * page offers it to the artwork picture as the fallback for a failed image
 * request, so artwork follows the same request-driven rule as the page data
 * instead of trusting `navigator.onLine`.
 */
export function useLocalArtworkUrl(
  catalogId: string,
  eventId: number,
  artworkId: string | null
): string | null {
  const record = useEventDownload(catalogId, eventId);
  const key = record?.status === "complete" && record.hasArtwork ? record.key : null;

  const { data: blob } = useQuery({
    queryKey: ["local-artwork", key, artworkId],
    networkMode: "always",
    enabled: key !== null && artworkId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const bundle = key ? await getDownloadBundle(key) : undefined;
      const artwork = bundle?.artwork;
      if (!artwork) return null;
      if (artwork.artworkId && artwork.artworkId !== artworkId) return null;
      return artwork.blob;
    },
  });

  return useObjectUrl(blob);
}
