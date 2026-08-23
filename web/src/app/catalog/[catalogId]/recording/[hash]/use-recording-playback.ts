"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useRadioMode } from "@/contexts/radio-mode-context";
import { useAudioPlayback } from "@/contexts/audio-playback-context";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  getSavedPlaybackPosition,
  isPlaybackCompleted,
  markPlaybackCompleted,
  savePlaybackPosition,
} from "@/lib/playback-position";

export interface RecordingSeekRequest {
  time: number;
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
  const fromRadio = searchParams.get("fromRadio") === "true";
  const seekParam = searchParams.get("seek");
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
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [seekRequest, setSeekRequest] = useState<RecordingSeekRequest | undefined>(undefined);
  const [autoPlayOnSeek, setAutoPlayOnSeek] = useState(false);

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
        `/api/catalogs/${catalogId}/recordings/${hash}/progress`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive: options.keepalive,
        }
      ).catch(() => {
        // Local storage remains the offline fallback; retry on a later visit.
      });
      lastServerSyncRef.current = now;
    },
    [catalogId, hash]
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
      if (restorePendingRef.current || restoreFailedRef.current) return;

      sendPlaybackProgress({
        completed: false,
        keepalive: options.keepalive ?? false,
        positionSec,
        durationSec,
      });
    },
    [hash, sendPlaybackProgress]
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
    if (autoPlayOnSeek && seekRequest) {
      const timer = setTimeout(() => setAutoPlayOnSeek(false), 100);
      return () => clearTimeout(timer);
    }
  }, [autoPlayOnSeek, seekRequest]);

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
    const parsedSeek = seekParam ? Number.parseFloat(seekParam) : Number.NaN;
    if (Number.isFinite(parsedSeek) && parsedSeek >= 0) {
      positionRestoredRef.current = true;
      setSeekRequest({ time: parsedSeek, key: Date.now() });
      return;
    }

    positionRestoredRef.current = true;

    const savedPosition = localPositionAtMountRef.current;
    if (savedPosition && savedPosition > 0) {
      setSeekRequest({ time: savedPosition, key: Date.now() });
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [hash, fromRadio, radio.isActive, seekParam]);

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
    void fetchJson<RemotePlaybackProgressResponse>(
      `/api/catalogs/${catalogId}/recordings/${hash}/progress`
    )
      .then((response) => {
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
          localPositionAtMountRef.current ?? 0
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
        const mergedPosition = Math.max(
          localPosition,
          remotePosition,
          currentTimeRef.current
        );
        const remoteDuration = remoteProgress?.durationSec ?? 0;
        if (remoteDuration > 0) {
          durationRef.current = remoteDuration;
        }

        if (mergedPosition <= 0) return;

        if (mergedPosition > remotePosition) {
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
    setIsPlaying(playing);
    if (!playing) {
      persistCurrentPlaybackPosition();
    }
  }, [persistCurrentPlaybackPosition]);

  const handleSeek = useCallback((time: number) => {
    playbackSeekedRef.current = true;
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
    seekRequest,
    setCurrentTime,
  };
}
