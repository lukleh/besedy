"use client";

/**
 * Hooks that resolve media from a completed download package for the shared
 * event and recording pages. Pages stay unaware of caches, data URLs and
 * storage formats; they receive a `src` and use it.
 */
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDownloadRecord, useEventDownload } from "@/hooks/use-downloads";
import { useOfflineAudioTransport } from "@/hooks/use-offline-audio-transport";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { getAudioCacheKey } from "@/lib/offline/audio-cache-format";
import { getDownloadBundle } from "@/lib/offline/downloads-db";

/**
 * Encode a stored recording as a data URL.
 *
 * WebKit rejects service-worker and blob-backed media once offline, so those
 * browsers play from an inline copy. This is the transport #163 replaces; it
 * lives here so it can be removed in one place.
 */
export function inlineAudioDataUrl(data: ArrayBuffer, contentType: string): string {
  const bytes = new Uint8Array(data);
  const encodedChunks: string[] = [];
  // Keep non-final chunks divisible by three so concatenated base64 has no
  // interior padding, while avoiding one extra full-size binary string.
  const chunkSize = 24 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    encodedChunks.push(
      btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)))
    );
  }
  return `data:${contentType};base64,${encodedChunks.join("")}`;
}

/**
 * The URL the player uses for a complete local recording. It differs from the
 * network URL only by a marker the worker and the server ignore, so the
 * browser treats the switch to local playback as a new media resource
 * instead of resuming a network stream that may have died.
 */
export function localAudioSrc(audioUrl: string): string {
  return `${audioUrl}${audioUrl.includes("?") ? "&" : "?"}local=1`;
}

export interface LocalAudioSource {
  /** Playable local source, or null when the page should use its network URL. */
  src: string | null;
  /** The local source is being prepared; hold the player until it resolves. */
  pending: boolean;
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
): LocalAudioSource {
  const record = useDownloadRecord(catalogId, hash);
  const { isOnline } = useOnlineStatus();
  const complete = record?.status === "complete" && !!record.audioUrl;
  const matchesSelection = useMemo(() => {
    if (!complete || !record?.audioCacheKey || typeof window === "undefined") {
      return false;
    }
    return (
      getAudioCacheKey(selectedUrl, window.location.origin) === record.audioCacheKey
    );
  }, [complete, record?.audioCacheKey, selectedUrl]);
  const useLocal = complete && (matchesSelection || !sourcesKnown || !isOnline);
  // The browser default can be overridden per device from the player's debug
  // panel, so a transport can be tried on a real phone without a release.
  const needsInline = useOfflineAudioTransport() === "inline";

  const inline = useQuery({
    queryKey: ["local-inline-audio", record?.key ?? null],
    enabled: useLocal && needsInline,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const bundle = record ? await getDownloadBundle(record.key) : undefined;
      return bundle?.inlineAudio
        ? inlineAudioDataUrl(bundle.inlineAudio.data, bundle.inlineAudio.contentType)
        : null;
    },
  });

  if (!useLocal || !record?.audioUrl) return { src: null, pending: false };
  const local = localAudioSrc(record.audioUrl);
  if (!needsInline) return { src: local, pending: false };
  if (inline.isPending) return { src: null, pending: true };
  return { src: inline.data ?? local, pending: false };
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

  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);
  return url;
}
