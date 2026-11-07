"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAudioPlayback } from "@/contexts/audio-playback-context";
import { useSession } from "@/contexts/session-context";
import { useDownloadRecord } from "@/hooks/use-downloads";
import { fetchJson } from "@/lib/api/fetch-json";
import { buildPlaybackProgressUrl } from "@/lib/api/recording-urls";
import { getPendingPlaybackProgress } from "@/lib/offline/downloads-db";
import { isNetworkFailure } from "@/lib/offline/local-source";
import {
  flushPendingPlaybackProgress,
  queuePlaybackProgress,
} from "@/lib/offline/playback-progress-sync";
import {
  getSavedPlaybackPosition,
  isPlaybackCompleted,
  markPlaybackCompleted,
  savePlaybackPosition,
} from "@/lib/playback-position";
import { isAtPlaybackEnd } from "@/lib/playback-progress";
import { createPlaybackClock } from "@/lib/playback-clock";

export interface RecordingSeekRequest {
  time: number;
  end?: number;
  key: number;
}

interface RemotePlaybackProgressResponse {
  progress: null | {
    positionSec: number;
    durationSec: number | null;
    completed: boolean;
  };
}

interface PlaybackPersistOptions {
  completed?: boolean;
  keepalive?: boolean;
  /** Save in this browser only; the server and the offline queue keep their cadence. */
  localOnly?: boolean;
  positionSec?: number;
  durationSec?: number;
}

// How often uninterrupted playback saves its position: in this browser, and
// to the server. With the screen off each request wakes the cellular radio
// for seconds of tail time, often as the only network use (a downloaded
// recording), and hiding the page already flushed the position, so the
// server waits longer then.
const LOCAL_PLAYBACK_SAVE_INTERVAL_MS = 5_000;
const SERVER_SYNC_INTERVAL_MS = 15_000;
const HIDDEN_SERVER_SYNC_INTERVAL_MS = 60_000;

/**
 * Owns playback persistence and seek restoration for a single recording view.
 */
export function useRecordingPlayback(catalogId: string, hash: string) {
  const searchParams = useSearchParams();
  const { setRecordingPlaying } = useAudioPlayback();
  const { session } = useSession();
  const userId = session?.user?.id ?? null;
  // The session-free offline shell has no signed-in user; progress made there
  // is queued for the account that downloaded the recording.
  const downloadRecord = useDownloadRecord(catalogId, hash);
  const progressOwnerId = userId ?? downloadRecord?.userId ?? null;
  const seekParam = searchParams.get("seek");
  const endParam = searchParams.get("end");
  const positionRestoredRef = useRef(false);
  const currentTimeRef = useRef(0);
  const isPlayingRef = useRef(false);
  const durationRef = useRef(0);
  const lastLocalSaveRef = useRef(0);
  const lastServerSyncRef = useRef(0);
  const localPositionAtMountRef = useRef(getSavedPlaybackPosition(hash));
  const completedLocallyRef = useRef(isPlaybackCompleted(hash));
  const restorePendingRef = useRef(!seekParam);
  const restoreFailedRef = useRef(false);
  const remoteRestoreAppliedRef = useRef(false);
  const playbackSeekedRef = useRef(false);
  const lastRequestRef = useRef<{ signature: string; sentAt: number } | null>(null);
  // The playback position lives in a clock rather than state, so time updates
  // re-render only what shows the time, not the whole page.
  const [clock] = useState(() => createPlaybackClock());
  const [isPlaying, setIsPlaying] = useState(false);
  const [seekRequest, setSeekRequest] = useState<RecordingSeekRequest | undefined>(undefined);

  // Durable offline progress: synchronised by the download-manager bridge on
  // the next successful connection.
  const queueOfflineProgress = useCallback(
    (options: { completed: boolean; positionSec: number; durationSec: number }) => {
      if (!progressOwnerId) return;
      void queuePlaybackProgress({
        userId: progressOwnerId,
        catalogId,
        hash,
        positionSec: options.positionSec,
        durationSec: options.durationSec > 0 ? options.durationSec : null,
        completed: options.completed,
      }).catch(() => {
        // Local storage still preserves resume state if IndexedDB is blocked.
      });
    },
    [catalogId, hash, progressOwnerId]
  );

  const sendPlaybackProgress = useCallback(
    (options: Required<Pick<PlaybackPersistOptions, "completed">> & {
      keepalive: boolean;
      positionSec: number;
      durationSec: number;
    }) => {
      const body = {
        positionSec: options.positionSec,
        durationSec: options.durationSec > 0 ? options.durationSec : null,
        completed: options.completed,
      };
      const signature = JSON.stringify(body);
      const now = Date.now();
      if (
        lastRequestRef.current?.signature === signature &&
        now - lastRequestRef.current.sentAt < 2_000
      ) {
        return;
      }
      lastRequestRef.current = { signature, sentAt: now };

      void fetchJson(
        buildPlaybackProgressUrl(catalogId, hash),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive: options.keepalive,
        }
      ).catch((error: unknown) => {
        // A request that never reached the server is kept for the next
        // connection; a server verdict is left to a later visit.
        if (isNetworkFailure(error)) {
          queueOfflineProgress({
            completed: options.completed,
            positionSec: options.positionSec,
            durationSec: options.durationSec,
          });
        }
      });
      lastServerSyncRef.current = now;
    },
    [catalogId, hash, queueOfflineProgress]
  );

  const persistCurrentPlaybackPosition = useCallback(
    (options: PlaybackPersistOptions = {}) => {
      const positionSec = Math.max(
        0,
        options.positionSec ?? currentTimeRef.current
      );
      const durationSec = Math.max(
        0,
        options.durationSec ?? durationRef.current
      );
      if (positionSec <= 0 && !options.completed && options.positionSec === undefined) {
        return;
      }

      // Reaching the end also finishes playback when the ended event was
      // missed, e.g. a position restored from browser-only storage.
      if (
        options.completed ||
        (!completedLocallyRef.current && isAtPlaybackEnd(positionSec, durationSec))
      ) {
        completedLocallyRef.current = true;
        markPlaybackCompleted(hash);
        sendPlaybackProgress({
          completed: true,
          keepalive: options.keepalive ?? false,
          positionSec,
          durationSec,
        });
        return;
      }

      if (completedLocallyRef.current) return;

      savePlaybackPosition(hash, positionSec, { clearWhenZero: true });
      lastLocalSaveRef.current = Date.now();
      if (restorePendingRef.current || options.localOnly) return;
      if (restoreFailedRef.current) {
        // The server could not be reached for this view. Writing directly
        // could overwrite a further position from another device, so the
        // position is queued and merged on reconnect instead.
        queueOfflineProgress({ completed: false, positionSec, durationSec });
        return;
      }

      sendPlaybackProgress({
        completed: false,
        keepalive: options.keepalive ?? false,
        positionSec,
        durationSec,
      });
    },
    [hash, queueOfflineProgress, sendPlaybackProgress]
  );

  useEffect(() => {
    setRecordingPlaying(isPlaying);
  }, [isPlaying, setRecordingPlaying]);

  useEffect(() => {
    return () => {
      setRecordingPlaying(false);
    };
  }, [setRecordingPlaying]);

  useEffect(() => {
    if (positionRestoredRef.current) return;

    // Restore the seek / saved position synchronously: a deferred microtask
    // guarded by a cleanup flag is dropped under React Strict Mode's
    // setup -> cleanup -> setup, so the position would never restore in dev.
    // The positionRestoredRef one-shot guard prevents re-entry / loops.
    /* eslint-disable react-hooks/set-state-in-effect -- one-shot position restore; must stay synchronous (see above) */
    const parsedSeek = seekParam ? Number.parseFloat(seekParam) : Number.NaN;
    if (Number.isFinite(parsedSeek) && parsedSeek >= 0) {
      const parsedEnd = endParam ? Number.parseFloat(endParam) : Number.NaN;
      positionRestoredRef.current = true;
      setSeekRequest({
        time: parsedSeek,
        ...(Number.isFinite(parsedEnd) && parsedEnd > parsedSeek
          ? { end: parsedEnd }
          : {}),
        key: Date.now(),
      });
      return;
    }

    positionRestoredRef.current = true;

    const savedPosition = localPositionAtMountRef.current;
    if (savedPosition && savedPosition > 0) {
      setSeekRequest({ time: savedPosition, key: Date.now() });
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [hash, endParam, seekParam]);

  useEffect(() => {
    if (remoteRestoreAppliedRef.current || seekParam) {
      restorePendingRef.current = false;
      return;
    }

    let cancelled = false;
    const loadProgress = async () => {
      if (userId && navigator.onLine) {
        await flushPendingPlaybackProgress(userId);
      }
      const [response, pending] = await Promise.all([
        fetchJson<RemotePlaybackProgressResponse>(
          buildPlaybackProgressUrl(catalogId, hash)
        ),
        userId
          ? getPendingPlaybackProgress(userId, catalogId, hash)
          : Promise.resolve(undefined),
      ]);
      return { pending, response };
    };

    void loadProgress()
      .then(({ pending, response }) => {
        if (
          cancelled ||
          remoteRestoreAppliedRef.current
        ) {
          return;
        }
        remoteRestoreAppliedRef.current = true;
        restorePendingRef.current = false;
        restoreFailedRef.current = false;
        lastServerSyncRef.current = Date.now();
        const localPosition = Math.max(
          0,
          pending?.positionSec ?? localPositionAtMountRef.current ?? 0
        );
        const remoteProgress = response.progress;

        if (completedLocallyRef.current) {
          markPlaybackCompleted(hash);
          if (!remoteProgress?.completed) {
            sendPlaybackProgress({
              completed: true,
              keepalive: false,
              positionSec: remoteProgress?.positionSec ?? 0,
              durationSec: remoteProgress?.durationSec ?? 0,
            });
          }
          if (localPosition > 0 || currentTimeRef.current > 0) {
            setSeekRequest({ time: 0, key: Date.now() });
          }
          return;
        }

        // Once the server has observed the real media-ended event, completion
        // is authoritative. A stale browser position must not reopen it midway.
        if (remoteProgress?.completed) {
          completedLocallyRef.current = true;
          markPlaybackCompleted(hash);
          if (localPosition > 0 || currentTimeRef.current > 0) {
            setSeekRequest({ time: 0, key: Date.now() });
          }
          return;
        }

        if (playbackSeekedRef.current) {
          sendPlaybackProgress({
            completed: false,
            keepalive: false,
            positionSec: currentTimeRef.current,
            durationSec: durationRef.current,
          });
          return;
        }

        const remotePosition = Math.max(
          0,
          remoteProgress?.positionSec ?? 0
        );
        // A dirty offline position represents a later explicit user action and
        // must win even when it moved backward. Without a pending entry, retain
        // the established furthest-position merge for cross-device restores.
        const mergedPosition = pending
          ? localPosition
          : Math.max(localPosition, remotePosition, currentTimeRef.current);
        const remoteDuration = remoteProgress?.durationSec ?? 0;
        if (remoteDuration > 0) {
          durationRef.current = remoteDuration;
        }

        if (mergedPosition <= 0) return;

        // A position left at the end (e.g. by an older client that saved it
        // after the ended event) is a finished listen, not one to resume.
        if (isAtPlaybackEnd(mergedPosition, durationRef.current)) {
          persistCurrentPlaybackPosition({
            completed: true,
            positionSec: mergedPosition,
            durationSec: durationRef.current,
          });
          setSeekRequest({ time: 0, key: Date.now() });
          return;
        }

        if (pending) {
          savePlaybackPosition(hash, mergedPosition, { clearWhenZero: true });
        } else if (mergedPosition > remotePosition) {
          // This is either the one-time migration from browser-only storage or
          // an offline session that advanced further. Import it immediately so
          // the progress is available on the user's other devices.
          persistCurrentPlaybackPosition({
            positionSec: mergedPosition,
            durationSec: remoteDuration,
          });
        } else {
          savePlaybackPosition(hash, mergedPosition);
        }

        setSeekRequest({
          time: mergedPosition,
          key: Date.now(),
        });
      })
      .catch(() => {
        if (cancelled) return;
        restorePendingRef.current = false;
        restoreFailedRef.current = true;
        // Offline playback continues locally. Suppress server writes for this
        // view because writing without a successful restore could overwrite a
        // further position saved by another device.
      });

    return () => {
      cancelled = true;
    };
  }, [
    catalogId,
    hash,
    persistCurrentPlaybackPosition,
    sendPlaybackProgress,
    seekParam,
    userId,
  ]);

  // The player re-attaches its media listeners when this callback changes, so
  // it stays the same for the view's lifetime and reaches the save through a
  // ref (the save changes as the session and download record load).
  const persistRef = useRef(persistCurrentPlaybackPosition);
  useEffect(() => {
    persistRef.current = persistCurrentPlaybackPosition;
  }, [persistCurrentPlaybackPosition]);

  // The player reports its time here about four times a second, also while
  // the page is hidden. Position saving reads it directly; the clock passes it
  // on to the view only while the page is visible.
  const setCurrentTime = useCallback((time: number) => {
    clock.set(time);
    currentTimeRef.current = time;
    // Persist periodically during long uninterrupted playback. Pause, hide,
    // navigation and completion are handled separately below.
    if (!isPlayingRef.current || time <= 0) return;
    const now = Date.now();
    if (now - lastLocalSaveRef.current < LOCAL_PLAYBACK_SAVE_INTERVAL_MS) return;
    const serverInterval =
      document.visibilityState === "hidden"
        ? HIDDEN_SERVER_SYNC_INTERVAL_MS
        : SERVER_SYNC_INTERVAL_MS;
    persistRef.current({
      localOnly: now - lastServerSyncRef.current < serverInterval,
    });
  }, [clock]);

  // Attach the beforeunload listener once per hash, not on every timeupdate —
  // the old combined effect was churning window listeners ~4x/second.
  useEffect(() => {
    const handleBeforeUnload = () => {
      persistCurrentPlaybackPosition({ keepalive: true });
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [persistCurrentPlaybackPosition]);

  useEffect(() => {
    const handlePageHide = () => {
      persistCurrentPlaybackPosition({ keepalive: true });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        persistCurrentPlaybackPosition({ keepalive: true });
      }
    };

    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [persistCurrentPlaybackPosition]);

  useEffect(() => {
    return () => {
      persistCurrentPlaybackPosition({ keepalive: true });
    };
  }, [persistCurrentPlaybackPosition]);

  const handleAudioEnded = useCallback((duration: number) => {
    const resolvedDuration = duration > 0 ? duration : durationRef.current;
    persistCurrentPlaybackPosition({
      completed: true,
      positionSec: resolvedDuration || currentTimeRef.current,
      durationSec: resolvedDuration,
      keepalive: true,
    });
  }, [persistCurrentPlaybackPosition]);

  const handleDurationChange = useCallback((duration: number) => {
    if (Number.isFinite(duration) && duration > 0) {
      durationRef.current = duration;
    }
  }, []);

  const handlePlayingChange = useCallback((playing: boolean) => {
    isPlayingRef.current = playing;
    setIsPlaying(playing);
    if (!playing) {
      persistCurrentPlaybackPosition();
    }
  }, [persistCurrentPlaybackPosition]);

  const noteSeek = useCallback((time: number) => {
    playbackSeekedRef.current = true;
    currentTimeRef.current = time;
    persistCurrentPlaybackPosition({ positionSec: time });
  }, [persistCurrentPlaybackPosition]);

  // Seeks from outside the player (transcript clicks, the stream timeline)
  // are handed to it as a request.
  const handleSeek = useCallback((time: number) => {
    noteSeek(time);
    setSeekRequest({ time, key: Date.now() });
  }, [noteSeek]);

  // The player has already moved the media element; sending its own seek
  // back as a request would seek a second time and restart the audio request.
  const handlePlayerSeek = useCallback((time: number) => {
    noteSeek(time);
    clock.set(time);
  }, [clock, noteSeek]);

  return {
    clock,
    handleAudioEnded,
    handleDurationChange,
    handlePlayerSeek,
    handlePlayingChange,
    handleSeek,
    isPlaying,
    seekRequest,
    setCurrentTime,
  };
}
