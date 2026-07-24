"use client";

import { useEffect, useState, useCallback } from "react";
import { useServiceWorker } from "@/contexts/service-worker-context";
import { SW_MESSAGE_TYPES, type SWToClientMessage } from "@/lib/service-worker/messages";

export type ContentCacheStatus =
  | "uncached"
  | "checking"
  | "caching"
  | "cached"
  | "partial"
  | "error";

interface ContentCacheState {
  status: ContentCacheStatus;
  /** Overall progress (0-100) */
  progress: number;
  /** Audio download progress (0-100) */
  audioProgress: number;
  /** Whether audio is fully cached */
  audioCached: boolean;
  /** Whether transcript is cached */
  transcriptCached: boolean;
  /** Which transcript backend is cached */
  transcriptBackend: string | null;
  /** Whether speakers/diarization is cached */
  speakersCached: boolean;
  /** Error message if caching failed */
  error: string | null;
  /** Total cached size in bytes */
  size: number | null;
}

/**
 * Hook for managing content (audio + transcript) cache state.
 *
 * Provides:
 * - Cache status tracking (uncached, caching, cached, partial, error)
 * - Progress tracking during caching
 * - Individual status for audio, transcript, and speakers
 * - Actions to start/clear caching
 */
export function useContentCache(
  hash: string | null,
  audioUrl: string | null,
  catalogId: string | null,
  transcriptBackend?: string
) {
  const { isReady, postMessage, subscribe } = useServiceWorker();
  const [state, setState] = useState<ContentCacheState>({
    status: "checking",
    progress: 0,
    audioProgress: 0,
    audioCached: false,
    transcriptCached: false,
    transcriptBackend: null,
    speakersCached: false,
    error: null,
    size: null,
  });

  // Check cache status on mount and when hash changes
  useEffect(() => {
    if (!isReady || !hash || !catalogId) {
      return;
    }

    // Use functional update to avoid ESLint warning
    const timer = setTimeout(() => {
      setState((prev) => ({ ...prev, status: "checking" }));
    }, 0);

    postMessage({
      type: SW_MESSAGE_TYPES.CHECK_CONTENT_CACHE,
      hash,
      catalogId,
    });

    return () => clearTimeout(timer);
  }, [isReady, hash, catalogId, postMessage]);

  // Derive effective status - if not ready, show uncached
  const effectiveStatus = (!isReady || !hash || !catalogId) ? "uncached" : state.status;

  // Subscribe to SW messages
  useEffect(() => {
    if (!isReady || !hash) return;

    const unsubscribe = subscribe((message: SWToClientMessage) => {
      // Only handle messages for this hash
      if (!("hash" in message) || message.hash !== hash) return;

      switch (message.type) {
        case SW_MESSAGE_TYPES.CONTENT_CACHE_STATUS:
          if (message.audioCached && message.audioComplete) {
            // Audio is fully cached - show as cached (transcript is optional)
            setState((prev) => ({
              ...prev,
              status: "cached",
              progress: 100,
              audioProgress: 100,
              audioCached: true,
              transcriptCached: message.transcriptCached,
              transcriptBackend: message.transcriptBackend || null,
              speakersCached: message.speakersCached,
              size: message.audioSize || null,
            }));
          } else if (message.audioCached && !message.audioComplete) {
            // Audio is partially cached (interrupted download) - show as partial to allow resume
            setState((prev) => ({
              ...prev,
              status: "partial",
              progress: message.audioProgress || 0,
              audioProgress: message.audioProgress || 0,
              audioCached: false,
              transcriptCached: message.transcriptCached,
              transcriptBackend: message.transcriptBackend || null,
              speakersCached: message.speakersCached,
            }));
          } else {
            setState((prev) => ({
              ...prev,
              status: "uncached",
              audioCached: false,
              transcriptCached: false,
              transcriptBackend: null,
              speakersCached: false,
            }));
          }
          break;

        case SW_MESSAGE_TYPES.CONTENT_CACHE_PROGRESS:
          setState((prev) => ({
            ...prev,
            status: "caching",
            progress: message.progress,
            audioProgress: message.audioProgress,
            error: null,
          }));
          break;

        case SW_MESSAGE_TYPES.CONTENT_CACHE_COMPLETE:
          setState((prev) => ({
            ...prev,
            status: "cached",
            progress: 100,
            audioProgress: 100,
            audioCached: true,
            transcriptCached: false, // Transcripts not cached via content cache
            speakersCached: false,
            size: message.audioSize,
            error: null,
          }));
          break;

        case SW_MESSAGE_TYPES.CONTENT_CACHE_ERROR:
          setState((prev) => ({
            ...prev,
            status: "error",
            progress: 0,
            error: message.error,
          }));
          break;
      }
    });

    return unsubscribe;
  }, [isReady, hash, subscribe]);

  // Start caching
  const startCaching = useCallback(() => {
    if (!isReady || !hash || !audioUrl || !catalogId) return;
    if (state.status === "caching" || state.status === "cached") return;

    setState((prev) => ({
      ...prev,
      status: "caching",
      progress: 0,
      audioProgress: 0,
      error: null,
    }));

    postMessage({
      type: SW_MESSAGE_TYPES.CACHE_CONTENT,
      hash,
      audioUrl,
      catalogId,
      transcriptBackend,
    });
  }, [isReady, audioUrl, hash, catalogId, transcriptBackend, state.status, postMessage]);

  // Clear cache
  const clearCache = useCallback(() => {
    if (!isReady || !hash) return;

    postMessage({
      type: SW_MESSAGE_TYPES.CLEAR_CONTENT_CACHE,
      hash,
    });

    setState((prev) => ({
      ...prev,
      status: "uncached",
      progress: 0,
      audioProgress: 0,
      audioCached: false,
      transcriptCached: false,
      transcriptBackend: null,
      speakersCached: false,
      size: null,
    }));
  }, [isReady, hash, postMessage]);

  return {
    ...state,
    status: effectiveStatus,
    isSupported: isReady,
    startCaching,
    clearCache,
  };
}
