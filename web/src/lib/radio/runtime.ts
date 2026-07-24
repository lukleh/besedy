"use client";

import { fetchJson } from "@/lib/api/fetch-json";
import { createClientLogger } from "@/lib/log/client";
import type { RandomEventResponse } from "@/types/api";

export interface RadioEventTrack {
  hash: string;
  catalogId: string;
  eventId: number;
  title: string;
  duration?: string;
  dateYear?: number | null;
  dateMonth?: number | null;
  dateDay?: number | null;
  locationName?: string | null;
}

/** Why the radio last stopped; null while it is playing. */
export type RadioStopReason = "user-stop" | "empty-pool" | "network-error" | null;

export interface RadioRuntimeSnapshot {
  isActive: boolean;
  currentTrack: RadioEventTrack | null;
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  bufferAhead: number;
  peakBuffer: number;
  networkState: number;
  isBuffering: boolean;
  stopReason: RadioStopReason;
}

export type RadioRuntimeListener = (snapshot: RadioRuntimeSnapshot) => void;

const HISTORY_KEY_PREFIX = "besedy-radio-history-";
const MAX_HISTORY_SIZE = 1000;
const MAX_FETCH_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const logger = createClientLogger("Radio");

// Play history is keyed by the primary recording's hash. Each released event
// contributes exactly one primary to the pool, so excluding a hash effectively
// excludes its event.
function getHistoryKey(catalogId: string): string {
  return `${HISTORY_KEY_PREFIX}${catalogId}`;
}

function loadHistory(catalogId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(getHistoryKey(catalogId));
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveHistory(catalogId: string, history: string[]): void {
  if (typeof window === "undefined") return;
  try {
    const trimmed = history.slice(-MAX_HISTORY_SIZE);
    localStorage.setItem(getHistoryKey(catalogId), JSON.stringify(trimmed));
  } catch {
    // Ignore localStorage errors
  }
}

function getAudioUrl(hash: string, catalogId: string): string {
  return `/api/catalogs/${catalogId}/recordings/${hash}/audio`;
}

function createInitialSnapshot(): RadioRuntimeSnapshot {
  return {
    isActive: false,
    currentTrack: null,
    isPlaying: false,
    isLoading: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    isMuted: false,
    bufferAhead: 0,
    peakBuffer: 0,
    networkState: 0,
    isBuffering: false,
    stopReason: null,
  };
}

export function createRadioRuntime() {
  let snapshot = createInitialSnapshot();
  let audio: HTMLAudioElement | null = null;
  let cleanupAudio: (() => void) | null = null;
  let playHistory: string[] = [];
  let currentCatalogId: string | null = null;
  let errorHandler: ((event: Event) => void) | null = null;
  let isFetchingNext = false;
  let fetchRetryCount = 0;

  const listeners = new Set<RadioRuntimeListener>();

  function emit() {
    const nextSnapshot = { ...snapshot };
    listeners.forEach((listener) => listener(nextSnapshot));
  }

  function setSnapshot(
    updater:
      | Partial<RadioRuntimeSnapshot>
      | ((current: RadioRuntimeSnapshot) => RadioRuntimeSnapshot)
  ) {
    snapshot =
      typeof updater === "function"
        ? updater(snapshot)
        : { ...snapshot, ...updater };
    emit();
  }

  function stopAudioAndClearSource() {
    if (!audio) return;

    if (errorHandler) {
      audio.removeEventListener("error", errorHandler);
    }
    audio.pause();
    audio.src = "";
    if (errorHandler) {
      audio.addEventListener("error", errorHandler);
    }
  }

  function stopRadioInternal(reason: RadioStopReason = "user-stop") {
    stopAudioAndClearSource();

    setSnapshot((current) => ({
      ...current,
      isActive: false,
      currentTrack: null,
      isPlaying: false,
      isLoading: false,
      currentTime: 0,
      duration: 0,
      stopReason: reason,
    }));

    currentCatalogId = null;
    isFetchingNext = false;
  }

  function playEventTrack(track: RadioEventTrack) {
    if (!audio) return;

    setSnapshot((current) => ({
      ...current,
      currentTrack: track,
      isLoading: true,
      currentTime: 0,
      duration: 0,
    }));

    audio.src = getAudioUrl(track.hash, track.catalogId);
    audio.load();
    audio.play().catch((error: unknown) => {
      logger.error("Failed to play:", error);
    });
  }

  async function fetchAndPlayNextEventTrack(catalogId: string): Promise<void> {
    if (isFetchingNext) return;
    isFetchingNext = true;

    try {
      if (fetchRetryCount >= MAX_FETCH_RETRIES) {
        logger.error("Max retries exceeded, stopping radio");
        fetchRetryCount = 0;
        stopRadioInternal("network-error");
        return;
      }

      const excludeHashes = playHistory.slice(-100);
      const params = new URLSearchParams();
      if (excludeHashes.length > 0) {
        params.set("exclude", excludeHashes.join(","));
      }

      const data = await fetchJson<RandomEventResponse>(
        `/api/catalogs/${catalogId}/random-event?${params}`
      );

      if (!data.hash) {
        logger.warn("No playable events found");
        fetchRetryCount = 0;
        stopRadioInternal("empty-pool");
        return;
      }

      fetchRetryCount = 0;

      if (data.historyReset) {
        playHistory = [];
        saveHistory(catalogId, []);
      }

      const track: RadioEventTrack = {
        hash: data.hash,
        catalogId,
        eventId: data.eventId ?? 0,
        title: data.title ?? data.hash,
        duration: data.duration,
        dateYear: data.dateYear,
        dateMonth: data.dateMonth,
        dateDay: data.dateDay,
        locationName: data.locationName,
      };

      playHistory.push(data.hash);
      if (playHistory.length > MAX_HISTORY_SIZE) {
        playHistory = playHistory.slice(-MAX_HISTORY_SIZE);
      }
      saveHistory(catalogId, playHistory);
      playEventTrack(track);
    } catch (error) {
      logger.error("Failed to fetch next track:", error);
      fetchRetryCount++;

      if (fetchRetryCount < MAX_FETCH_RETRIES) {
        const delay = Math.min(
          INITIAL_RETRY_DELAY_MS * Math.pow(2, fetchRetryCount - 1),
          10000
        );
        logger.info(
          `Retrying in ${delay}ms (attempt ${fetchRetryCount}/${MAX_FETCH_RETRIES})`
        );
        isFetchingNext = false;
        setTimeout(() => {
          void fetchAndPlayNextEventTrack(catalogId);
        }, delay);
        return;
      }

      logger.error("Max retries exceeded, stopping radio");
      fetchRetryCount = 0;
      stopRadioInternal("network-error");
    } finally {
      isFetchingNext = false;
    }
  }

  function playNextEventTrack() {
    if (!currentCatalogId) return;
    void fetchAndPlayNextEventTrack(currentCatalogId);
  }

  function attachAudioRuntime() {
    if (cleanupAudio) {
      return cleanupAudio;
    }

    const nextAudio = new Audio();
    nextAudio.preload = "metadata";
    audio = nextAudio;

    const handleTimeUpdate = () => {
      setSnapshot((current) => ({ ...current, currentTime: nextAudio.currentTime }));
    };

    const handleDurationChange = () => {
      setSnapshot((current) => ({ ...current, duration: nextAudio.duration || 0 }));
    };

    const handlePlay = () => {
      setSnapshot((current) => ({ ...current, isPlaying: true }));
    };

    const handlePause = () => {
      setSnapshot((current) => ({ ...current, isPlaying: false }));
    };

    const handleEnded = () => {
      setSnapshot((current) => ({ ...current, isPlaying: false }));
      playNextEventTrack();
    };

    const handleCanPlay = () => {
      setSnapshot((current) => ({
        ...current,
        isLoading: false,
        isBuffering: false,
      }));
    };

    const handleWaiting = () => {
      setSnapshot((current) => ({
        ...current,
        isLoading: true,
        isBuffering: true,
      }));
    };

    const handlePlaying = () => {
      setSnapshot((current) => ({ ...current, isBuffering: false }));
    };

    const updateBufferInfo = () => {
      const buffered = nextAudio.buffered;
      let bufferAheadValue = 0;

      for (let index = 0; index < buffered.length; index += 1) {
        const start = buffered.start(index);
        const end = buffered.end(index);
        if (nextAudio.currentTime >= start && nextAudio.currentTime <= end) {
          bufferAheadValue = end - nextAudio.currentTime;
          break;
        }
      }

      setSnapshot((current) => {
        const bufferIncreased = bufferAheadValue > current.bufferAhead + 1;
        return {
          ...current,
          bufferAhead: bufferAheadValue,
          peakBuffer: bufferIncreased ? bufferAheadValue : current.peakBuffer,
          networkState: nextAudio.networkState,
        };
      });
    };

    const handleProgress = () => {
      updateBufferInfo();
    };

    const handleError = (event: Event) => {
      const audioElement = event.target as HTMLAudioElement;
      const src = audioElement?.src || "";
      const isAudioUrl =
        src.includes("/api/catalogs/") &&
        src.includes("/recordings/") &&
        src.includes("/audio");

      if (!isAudioUrl) {
        logger.debug("Ignoring error for non-audio URL:", src || "(empty)");
        return;
      }

      const nextError = audioElement?.error;
      logger.error("Audio error:", {
        code: nextError?.code,
        message: nextError?.message,
        src,
        networkState: audioElement?.networkState,
        readyState: audioElement?.readyState,
      });

      playNextEventTrack();
    };

    errorHandler = handleError;

    nextAudio.addEventListener("timeupdate", handleTimeUpdate);
    nextAudio.addEventListener("durationchange", handleDurationChange);
    nextAudio.addEventListener("play", handlePlay);
    nextAudio.addEventListener("pause", handlePause);
    nextAudio.addEventListener("ended", handleEnded);
    nextAudio.addEventListener("canplay", handleCanPlay);
    nextAudio.addEventListener("waiting", handleWaiting);
    nextAudio.addEventListener("playing", handlePlaying);
    nextAudio.addEventListener("progress", handleProgress);
    nextAudio.addEventListener("error", handleError);

    cleanupAudio = () => {
      nextAudio.removeEventListener("timeupdate", handleTimeUpdate);
      nextAudio.removeEventListener("durationchange", handleDurationChange);
      nextAudio.removeEventListener("play", handlePlay);
      nextAudio.removeEventListener("pause", handlePause);
      nextAudio.removeEventListener("ended", handleEnded);
      nextAudio.removeEventListener("canplay", handleCanPlay);
      nextAudio.removeEventListener("waiting", handleWaiting);
      nextAudio.removeEventListener("playing", handlePlaying);
      nextAudio.removeEventListener("progress", handleProgress);
      nextAudio.removeEventListener("error", handleError);
      nextAudio.pause();
      nextAudio.src = "";
      audio = null;
      errorHandler = null;
      cleanupAudio = null;
    };

    return cleanupAudio;
  }

  return {
    getSnapshot() {
      return { ...snapshot };
    },

    subscribe(listener: RadioRuntimeListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      return attachAudioRuntime();
    },

    async startRadio(catalogId: string) {
      setSnapshot((current) => ({
        ...current,
        isLoading: true,
        isActive: true,
        stopReason: null,
      }));
      currentCatalogId = catalogId;
      playHistory = loadHistory(catalogId);
      await fetchAndPlayNextEventTrack(catalogId);
    },

    stopRadio() {
      stopRadioInternal();
    },

    skipToNext() {
      if (!snapshot.isActive) return;
      playNextEventTrack();
    },

    pause() {
      audio?.pause();
    },

    resume() {
      audio?.play().catch((error: unknown) => {
        logger.error("Failed to resume:", error);
      });
    },

    seekTo(time: number) {
      if (!audio) return;
      audio.currentTime = time;
      setSnapshot((current) => ({ ...current, currentTime: time }));
    },

    handOffPlayback() {
      const time = audio?.currentTime || 0;
      const wasPlaying = snapshot.isPlaying;

      stopAudioAndClearSource();
      setSnapshot((current) => ({
        ...current,
        isActive: false,
        currentTrack: null,
        isPlaying: false,
        isLoading: false,
        currentTime: 0,
        duration: 0,
      }));

      currentCatalogId = null;
      isFetchingNext = false;

      return { time, wasPlaying };
    },

    setVolume(nextVolume: number) {
      if (!audio) return;

      const clampedVolume = Math.max(0, Math.min(1, nextVolume));
      audio.volume = clampedVolume;
      setSnapshot((current) => ({
        ...current,
        volume: clampedVolume,
        isMuted: clampedVolume === 0,
      }));
    },

    toggleMute() {
      if (!audio) return;

      if (snapshot.isMuted) {
        audio.volume = snapshot.volume || 1;
        setSnapshot((current) => ({ ...current, isMuted: false }));
        return;
      }

      audio.volume = 0;
      setSnapshot((current) => ({ ...current, isMuted: true }));
    },
  };
}
