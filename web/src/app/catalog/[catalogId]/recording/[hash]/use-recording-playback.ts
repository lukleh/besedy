"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useRadioMode } from "@/contexts/radio-mode-context";
import { useAudioPlayback } from "@/contexts/audio-playback-context";
import {
  clearPlaybackPosition,
  getSavedPlaybackPosition,
  savePlaybackPosition,
} from "@/lib/playback-position";

export interface RecordingSeekRequest {
  time: number;
  key: number;
}

/**
 * Owns playback persistence, seek restoration, and radio handoff for a single
 * recording detail view.
 */
export function useRecordingPlayback(hash: string) {
  const searchParams = useSearchParams();
  const radio = useRadioMode();
  const { setRecordingPlaying } = useAudioPlayback();
  const fromRadio = searchParams.get("fromRadio") === "true";
  const seekParam = searchParams.get("seek");
  const radioHandoffDone = useRef(false);
  const radioHandoffSucceeded = useRef(false);
  const positionRestoredRef = useRef(false);
  const currentTimeRef = useRef(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [seekRequest, setSeekRequest] = useState<RecordingSeekRequest | undefined>(undefined);
  const [autoPlayOnSeek, setAutoPlayOnSeek] = useState(false);

  const persistCurrentPlaybackPosition = useCallback(() => {
    savePlaybackPosition(hash, currentTimeRef.current);
  }, [hash]);

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

    const savedPosition = getSavedPlaybackPosition(hash);
    if (savedPosition && savedPosition > 0) {
      setSeekRequest({ time: savedPosition, key: Date.now() });
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [hash, fromRadio, radio.isActive, seekParam]);

  // The position-save timer intentionally re-runs on every currentTime tick
  // so its 5s timeout keeps getting reset; the effect debounces writes to
  // storage during continuous playback.
  useEffect(() => {
    if (!isPlaying || currentTime <= 0) return;
    const timer = setTimeout(() => {
      savePlaybackPosition(hash, currentTime);
    }, 5000);
    return () => clearTimeout(timer);
  }, [currentTime, hash, isPlaying]);

  // Attach the beforeunload listener once per hash, not on every timeupdate —
  // the old combined effect was churning window listeners ~4x/second.
  useEffect(() => {
    const handleBeforeUnload = () => {
      persistCurrentPlaybackPosition();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [persistCurrentPlaybackPosition]);

  useEffect(() => {
    const handlePageHide = () => {
      persistCurrentPlaybackPosition();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        persistCurrentPlaybackPosition();
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
      persistCurrentPlaybackPosition();
    };
  }, [persistCurrentPlaybackPosition]);

  const handleAudioEnded = useCallback(() => {
    clearPlaybackPosition(hash);
  }, [hash]);

  const handlePlayingChange = useCallback((playing: boolean) => {
    setIsPlaying(playing);
    if (!playing) {
      persistCurrentPlaybackPosition();
    }
  }, [persistCurrentPlaybackPosition]);

  const handleSeek = useCallback((time: number) => {
    setSeekRequest({ time, key: Date.now() });
    savePlaybackPosition(hash, time, { clearWhenZero: true });
  }, [hash]);

  return {
    autoPlayOnSeek,
    currentTime,
    handleAudioEnded,
    handlePlayingChange,
    handleSeek,
    isPlaying,
    seekRequest,
    setCurrentTime,
  };
}
