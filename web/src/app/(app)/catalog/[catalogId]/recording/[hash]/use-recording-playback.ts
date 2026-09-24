"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useRadioMode } from "@/contexts/radio-mode-context";
import { useAudioPlayback } from "@/contexts/audio-playback-context";
import { useSession } from "@/contexts/session-context";
import { useDownloadRecord } from "@/hooks/use-downloads";
import { fetchJson } from "@/lib/api/fetch-json";
import { buildPlaybackProgressUrl } from "@/lib/api/recording-urls";
import { getPendingPlaybackProgress } from "@/lib/offline/downloads-db";
import {
  clearNowPlaying,
  saveNowPlaying,
  stopNowPlaying,
  takeResumableNowPlaying,
} from "@/lib/now-playing";
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
  positionSec?: number;
  durationSec?: number;
}

const LOCAL_PLAYBACK_SAVE_INTERVAL_MS = 5_000;

/**
 * Owns playback persistence, seek restoration, and radio handoff for a single
 * recording detail view.
 */
export function useRecordingPlayback(catalogId: string, hash: string) {
  const searchParams = useSearchParams();
  const radio = useRadioMode();
  const { setRecordingPlaying } = useAudioPlayback();
  const { session } = useSession();
  const userId = session?.user?.id ?? null;
  // The session-free offline shell has no signed-in user; progress made there
  // is queued for the account that downloaded the recording.
  const downloadRecord = useDownloadRecord(catalogId, hash);
  const progressOwnerId = userId ?? downloadRecord?.userId ?? null;
  const fromRadio = searchParams.get("fromRadio") === "true";
  const seekParam = searchParams.get("seek");
  const endParam = searchParams.get("end");
  const radioHandoffDone = useRef(false);
  const radioHandoffSucceeded = useRef(false);
  const positionRestoredRef = useRef(false);
  const currentTimeRef = useRef(0);
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
  const isPlayingRef = useRef(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [seekRequest, setSeekRequest] = useState<RecordingSeekRequest | undefined>(undefined);
  // Play as soon as the pending seek applies. Set by the radio handoff and by
  // an interrupted session; cleared once playback starts or the listener
  // seeks, so a later seek never starts a paused player on its own.
  const [autoPlayOnSeek, setAutoPlayOnSeek] = useState(false);
  // What this view decided about interrupted playback, for the player's log.
  const [launchNote, setLaunchNote] = useState<string | null>(null);

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

      // Heartbeat for the interrupted-session check: a kill leaves this as the
      // last word, a pause or close overwrites it below.
      if (isPlayingRef.current && !options.completed) {
        saveNowPlaying({ catalogId, hash, positionSec, playing: true });
      }

      if (options.completed) {
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
      if (restorePendingRef.current) return;
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
    [catalogId, hash, queueOfflineProgress, sendPlaybackProgress]
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
    if (!radio.isActive || radioHandoffDone.current) return;

    // Handoff: the radio banner links here with ?fromRadio=true. When the radio
    // is on this same recording (e.g. an event's primary), take over its
    // position and keep playing; otherwise stop the radio so two players don't
    // sound at once.
    if (fromRadio && radio.currentTrack?.hash === hash) {
      const { time, wasPlaying } = radio.handOffPlayback();
      radioHandoffSucceeded.current = true;
      radioHandoffDone.current = true;
      restorePendingRef.current = false;
      // Apply the handoff position synchronously, not from a deferred
      // microtask. Under React Strict Mode the effect runs setup -> cleanup ->
      // setup: a microtask guarded by a `cancelled` cleanup flag was dropped on
      // the first cleanup and never re-queued (the refs already mark the handoff
      // done), leaving the event player paused at 0. The radioHandoffDone ref
      // guards re-entry, so this one-shot controlled seek cannot loop.
      /* eslint-disable react-hooks/set-state-in-effect -- intentional one-shot controlled seek; must stay synchronous (see above) */
      if (time > 0) {
        setSeekRequest({ time, key: Date.now() });
      }
      if (wasPlaying) {
        setAutoPlayOnSeek(true);
      }
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }

    radio.stopRadio();
    radioHandoffDone.current = true;
  }, [radio, fromRadio, hash]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    if (positionRestoredRef.current) return;
    if (fromRadio && radio.isActive && !radioHandoffDone.current) return;
    if (fromRadio && radioHandoffSucceeded.current) {
      positionRestoredRef.current = true;
      return;
    }

    // Restore the seek / saved position synchronously, for the same reason as
    // the handoff effect above: a deferred microtask guarded by a cleanup flag
    // is dropped under React Strict Mode's setup -> cleanup -> setup, so the
    // position would never restore in dev. The positionRestoredRef one-shot
    // guard prevents re-entry / loops.
    /* eslint-disable react-hooks/set-state-in-effect -- one-shot position restore; must stay synchronous (see above) */
    // Consumed on every load so a shared link opened after a kill does not
    // leave the record to resume some later visit.
    const interrupted = takeResumableNowPlaying(catalogId, hash);
    const parsedSeek = seekParam ? Number.parseFloat(seekParam) : Number.NaN;
    if (Number.isFinite(parsedSeek) && parsedSeek >= 0) {
      const parsedEnd = endParam ? Number.parseFloat(endParam) : Number.NaN;
      positionRestoredRef.current = true;
      setLaunchNote("Seek from the URL; interrupted playback not considered");
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
    if (interrupted.record) {
      // The page is back after the OS killed the app mid-playback: continue
      // where it stopped. A deliberate pause or close would have cleared the
      // playing flag, so this never restarts audio the listener turned off.
      const time = Math.max(savedPosition ?? 0, interrupted.record.positionSec);
      setLaunchNote(`Resuming interrupted playback from ${time.toFixed(0)}s`);
      setSeekRequest({ time, key: Date.now() });
      setAutoPlayOnSeek(true);
      return;
    }
    setLaunchNote(`No interrupted playback (${interrupted.reason})`);

    if (savedPosition && savedPosition > 0) {
      setSeekRequest({ time: savedPosition, key: Date.now() });
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [catalogId, hash, endParam, fromRadio, radio.isActive, seekParam]);

  useEffect(() => {
    if (
      remoteRestoreAppliedRef.current ||
      seekParam ||
      radioHandoffSucceeded.current
    ) {
      restorePendingRef.current = false;
      return;
    }
    if (fromRadio && radio.isActive) return;

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
    fromRadio,
    hash,
    persistCurrentPlaybackPosition,
    radio.isActive,
    sendPlaybackProgress,
    seekParam,
    userId,
  ]);

  // Persist periodically during long uninterrupted playback. Pause, hide,
  // navigation and completion are handled separately below.
  useEffect(() => {
    if (!isPlaying || currentTime <= 0) return;
    const now = Date.now();
    if (now - lastLocalSaveRef.current < LOCAL_PLAYBACK_SAVE_INTERVAL_MS) return;
    if (now - lastServerSyncRef.current < 15_000) return;
    persistCurrentPlaybackPosition();
  }, [currentTime, isPlaying, persistCurrentPlaybackPosition]);

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
    // Hiding keeps the session alive: the app is in the background, possibly
    // still playing. Unloading is a deliberate close, a reload or a navigation
    // away, none of which should come back playing.
    const handlePageHide = () => {
      persistCurrentPlaybackPosition({ keepalive: true });
      stopNowPlaying(hash);
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
  }, [hash, persistCurrentPlaybackPosition]);

  // Unmount only. persistCurrentPlaybackPosition changes identity when the
  // progress owner resolves, which must not look like leaving the page.
  const persistOnLeaveRef = useRef(persistCurrentPlaybackPosition);
  useEffect(() => {
    persistOnLeaveRef.current = persistCurrentPlaybackPosition;
  }, [persistCurrentPlaybackPosition]);
  useEffect(() => {
    return () => {
      persistOnLeaveRef.current({ keepalive: true });
      // Leaving the page in the app stops the recording; it is not interrupted.
      stopNowPlaying(hash);
    };
  }, [hash]);

  const handleAudioEnded = useCallback((duration: number) => {
    const resolvedDuration = duration > 0 ? duration : durationRef.current;
    clearNowPlaying(hash);
    persistCurrentPlaybackPosition({
      completed: true,
      positionSec: resolvedDuration || currentTimeRef.current,
      durationSec: resolvedDuration,
      keepalive: true,
    });
  }, [hash, persistCurrentPlaybackPosition]);

  const handleDurationChange = useCallback((duration: number) => {
    if (Number.isFinite(duration) && duration > 0) {
      durationRef.current = duration;
    }
  }, []);

  const handlePlayingChange = useCallback((playing: boolean) => {
    isPlayingRef.current = playing;
    setIsPlaying(playing);
    if (playing) {
      setAutoPlayOnSeek(false);
      saveNowPlaying({
        catalogId,
        hash,
        positionSec: currentTimeRef.current,
        playing: true,
      });
      return;
    }
    persistCurrentPlaybackPosition();
    stopNowPlaying(hash);
  }, [catalogId, hash, persistCurrentPlaybackPosition]);

  const handleSeek = useCallback((time: number) => {
    playbackSeekedRef.current = true;
    setAutoPlayOnSeek(false);
    setSeekRequest({ time, key: Date.now() });
    currentTimeRef.current = time;
    persistCurrentPlaybackPosition({ positionSec: time });
  }, [persistCurrentPlaybackPosition]);

  return {
    autoPlayOnSeek,
    currentTime,
    handleAudioEnded,
    handleDurationChange,
    handlePlayingChange,
    handleSeek,
    isPlaying,
    launchNote,
    seekRequest,
    setCurrentTime,
  };
}
