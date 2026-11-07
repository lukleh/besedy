'use client';

/**
 * Audio player for one recording.
 *
 * The visible controls live in AudioPlayerChrome; this component owns the
 * media element and three behaviours around it:
 *
 * - Source switches for the same recording. The page hands the player a
 *   network URL first and, once a download completes, the local package URL
 *   that the service worker serves. The switch is a real
 *   source change; position and play intent carry across it.
 * - Recovery from network errors while streaming a recording that is not
 *   downloaded (useAudioRecovery): exponential retries that reload the
 *   element, then restore position and resume when the listener had asked
 *   for playback.
 * - Position restore after a mobile browser discarded the media in the
 *   background, from the position saved in localStorage.
 *
 * A debug panel (toggle in the chrome) shows buffer state and the event log.
 */

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useImperativeHandle,
} from 'react';
import { AudioPlayerChrome } from './audio-player-chrome';
import { AudioPlayerDebugPanel } from './audio-player-debug-panel';
import { createPlaybackClock } from '@/lib/playback-clock';
import { isRetrying } from './audio-player-retry-state';
import type { AudioPlayerProps, AudioPlayerControls } from './audio-player-types';
import { extractRecordingHash, safePlay } from './audio-player-utils';
import { useAudioBufferDiagnostics } from './use-audio-buffer-diagnostics';
import { useAudioRecovery, type PendingSeek } from './use-audio-recovery';
import { useDebugEventLog } from './use-debug-event-log';
import { useMediaSession } from './use-media-session';
import { useSleepFade } from './use-sleep-fade';
import { useVolumeControls } from './use-volume-controls';
import { useDownloadRecord } from '@/hooks/use-downloads';
import { getSavedPlaybackPosition } from '@/lib/playback-position';
import { useSleepTimerTarget } from '@/contexts/sleep-timer-context';

function resolvePlaybackEnd(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Renders the page's controls as an element rather than calling the render
 * prop inline: the actions read refs, which may only happen from their events,
 * not during this render. Not memoised; time reaches the controls through the
 * page's subscription, not through these props.
 */
function CustomControls({ render, controls }: {
  render: NonNullable<AudioPlayerProps['renderControls']>;
  controls: AudioPlayerControls;
}) {
  return render(controls);
}

export function AudioPlayer({
  ref,
  src,
  recordingHash,
  catalogId,
  downloadEventId,
  onTimeUpdate,
  onDurationChange,
  onPlayingChange,
  onPlayRequestChange,
  onSeek,
  onEnded,
  seekTo,
  seekKey,
  playbackEnd,
  autoPlayOnSeek,
  playbackRate,
  sleepTimerEnabled = true,
  mediaMetadata,
  markers,
  onBookmark,
  playbackRange,
  renderControls,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const rangeStart = playbackRange?.start;
  const rangeEnd = playbackRange?.end;

  // The recording identity drives download state; fall back to the API URL
  // shape when the caller did not name it.
  const hash = useMemo(() => {
    return recordingHash ?? extractRecordingHash(src);
  }, [recordingHash, src]);

  // Download state feeds the cached indicator and the debug panel; the switch
  // to local playback itself arrives as a new src from the page.
  const downloadRecord = useDownloadRecord(catalogId ?? null, hash);
  const cacheStatus = downloadRecord?.status ?? 'none';

  // The position the controls show. A clock rather than state: the element
  // reports its time about four times a second, and as state each report
  // re-rendered every control. Only the progress bar and its time labels
  // read it (see AudioPlayerChrome), and the debug panel while it is open.
  const [timeClock] = useState(() => createPlaybackClock());
  const [duration, setDuration] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const {
    bufferInfo,
    diagnostics,
    reset: resetBufferDiagnostics,
    updateDebugInfo,
  } = useAudioBufferDiagnostics({ audioRef, debugEnabled: showDebug, src });
  const { debugEvents, logDebugEvent, resetDebugEvents } = useDebugEventLog(src);
  const playbackEndRef = useRef<number | null>(
    resolvePlaybackEnd(playbackEnd),
  );

  useEffect(() => {
    playbackEndRef.current = resolvePlaybackEnd(playbackEnd);
  }, [playbackEnd]);

  // A new source resets the element's rate, so it is applied again with it.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const rate = playbackRate && playbackRate > 0 ? playbackRate : 1;
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
  }, [playbackRate, src]);

  const prevSrcRef = useRef(src); // Track previous src for change detection
  const prevRecordingHashRef = useRef(recordingHash);
  // Last playback position React observed; survives the element reset that a
  // src change performs before effects run.
  const lastTimeRef = useRef(0);
  const setCurrentTime = useCallback(
    (time: number) => {
      lastTimeRef.current = time;
      timeClock.set(time);
    },
    [timeClock],
  );
  // What the listener asked for, shared with recovery (see PlaybackIntentRefs).
  const userInitiatedRef = useRef(false);
  const playIntentRef = useRef(false);
  const pendingSeekRef = useRef<PendingSeek | null>(null);

  const { cancelSleepFade, sleepFadeOutAndPause } = useSleepFade({
    audioRef,
    playIntentRef,
    logDebugEvent,
  });

  const onPlaybackInterrupted = useCallback(() => {
    setIsPlaying(false);
    onPlayingChange?.(false);
  }, [onPlayingChange]);
  const recovery = useAudioRecovery({
    audioRef,
    intent: { pendingSeekRef, playIntentRef, userInitiatedRef },
    isPlaying,
    logDebugEvent,
    setCurrentTime,
    setIsBuffering,
    onPlaybackInterrupted,
    onPlayRequestChange,
  });
  const {
    retryStateRef,
    isReconnecting,
    dispatchRetry,
    recordedErrorTakesOverPlay,
    isPlayRequested,
    syncPlayRequest,
    relativeSeekBase,
    resetForSource,
    clearMediaError,
    reloadFrom,
    handleError,
    handleCanPlay: handleRecoveryCanPlay,
    handleLoadedMetadata: handleRecoveryLoadedMetadata,
  } = recovery;

  const lastExternalSeekRef = useRef<{
    recording: string;
    time: number;
    key: number | undefined;
  } | null>(null);

  const restoreSavedPositionAfterResume = useCallback(() => {
    const audio = audioRef.current;
    if (
      !audio ||
      !hash ||
      !audio.paused ||
      audio.currentTime > 0 ||
      pendingSeekRef.current
    ) {
      return;
    }

    // A correction range has its own position; the listener's saved position
    // for the whole recording may belong to an unrelated passage.
    const savedPosition = rangeStart !== undefined && rangeEnd !== undefined
      ? Math.max(rangeStart, Math.min(rangeEnd, lastTimeRef.current))
      : getSavedPlaybackPosition(hash);
    if (!savedPosition || savedPosition <= 0) {
      return;
    }

    if (audio.readyState >= 1) {
      audio.currentTime = savedPosition;
      setCurrentTime(savedPosition);
      onTimeUpdate?.(savedPosition);
      logDebugEvent(
        'seek',
        'Restored saved position after resume',
        `To ${savedPosition.toFixed(1)}s`,
      );
      return;
    }

    pendingSeekRef.current = { time: savedPosition, autoPlay: false };
    logDebugEvent(
      'seek',
      'Queued saved position after resume',
      `To ${savedPosition.toFixed(1)}s`,
    );
  }, [hash, rangeStart, rangeEnd, onTimeUpdate, logDebugEvent, setCurrentTime]);

  useEffect(() => {
    const handlePageShow = () => {
      restoreSavedPositionAfterResume();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const audio = audioRef.current;
        restoreSavedPositionAfterResume();
        // A discarded element reports 0. Restore (or queue) the logical
        // position before replacing the clock with that reset native value.
        if (audio && !pendingSeekRef.current) setCurrentTime(audio.currentTime);
      }
    };

    window.addEventListener('pageshow', handlePageShow);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('pageshow', handlePageShow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [restoreSavedPositionAfterResume, setCurrentTime]);

  // Reset state when audio source changes (not on initial mount)
  useEffect(() => {
    // Skip on initial mount - only run when src actually changes
    const previousSrc = prevSrcRef.current;
    if (previousSrc === src) {
      return;
    }
    const previousHash = extractRecordingHash(previousSrc);
    const nextHash = extractRecordingHash(src);
    // Same recording, different transport or variant: a named recording hash
    // covers sources whose URL carries no hash, such as a local data URL.
    const sameRecording =
      (!!previousHash && !!nextHash && previousHash === nextHash) ||
      (recordingHash !== undefined &&
        prevRecordingHashRef.current === recordingHash);

    prevSrcRef.current = src;
    prevRecordingHashRef.current = recordingHash;
    // A different recording starts from the listener's next decision.
    if (!sameRecording) playIntentRef.current = false;

    // Reset user interaction tracking
    userInitiatedRef.current = false;
    cancelSleepFade();

    // Reset the retry machine; its pending timer is cancelled with it.
    resetForSource();

    // Preserve seek target/position when only switching source variants for the same recording.
    const queuedSeek = pendingSeekRef.current;
    let restoreAfterSourceSwitch: PendingSeek | null = null;

    // Ensure audio element is stopped/reset
    const audio = audioRef.current;
    if (audio) {
      if (sameRecording) {
        if (queuedSeek) {
          restoreAfterSourceSwitch = queuedSeek;
        } else {
          // The element may already have reset for the new src; the refs hold
          // what the listener last saw and wanted.
          const time = Math.max(audio.currentTime, lastTimeRef.current);
          const autoPlay = !audio.paused || playIntentRef.current;
          if (time > 0 || autoPlay) {
            restoreAfterSourceSwitch = { time, autoPlay };
          }
        }
      }
      audio.pause();
      // Setting currentTime can throw if metadata isn't loaded yet
      try {
        audio.currentTime = 0;
      } catch {
        // Ignore - audio will start from beginning anyway with new src
      }
    }
    pendingSeekRef.current = restoreAfterSourceSwitch;
    syncPlayRequest();

    // Reset UI state - deferred to avoid synchronous setState in effect body
    queueMicrotask(() => {
      setIsBuffering(false);
      clearMediaError();
      setCurrentTime(restoreAfterSourceSwitch?.time ?? 0);
      setDuration(0);
      setIsPlaying(false);
      resetBufferDiagnostics();
      resetDebugEvents(src);
      onPlayingChange?.(false);
    });
  }, [src, recordingHash, onPlayingChange, resetForSource, clearMediaError, resetBufferDiagnostics, resetDebugEvents, cancelSleepFade, setCurrentTime, syncPlayRequest]);

  // Consume each external request once. Callback changes and the page clearing
  // autoPlayOnSeek must not replay an old request over a later user seek. The
  // recording identity survives transport changes; the source-switch effect
  // above restores the latest position before a genuinely new request is read.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || seekTo === undefined || !Number.isFinite(seekTo) || seekTo < 0) {
      lastExternalSeekRef.current = null;
      return;
    }
    const recording = hash ?? src;
    const previous = lastExternalSeekRef.current;
    if (
      previous?.recording === recording &&
      previous.time === seekTo &&
      previous.key === seekKey
    ) {
      return;
    }
    lastExternalSeekRef.current = { recording, time: seekTo, key: seekKey };
    dispatchRetry({ type: 'SEEK_REQUESTED', time: seekTo });
    // Each request re-arms its excerpt end. A finished excerpt clears the end,
    // and asking for the same excerpt again passes the same prop, which the
    // effect that tracks it would not see; the replay then ran on unstopped.
    playbackEndRef.current = resolvePlaybackEnd(playbackEnd);

    if (audio.readyState >= 1) {
      // A newer request also supersedes a seek queued before metadata arrived.
      pendingSeekRef.current = null;
      audio.currentTime = seekTo;
      setCurrentTime(seekTo);
      onTimeUpdate?.(seekTo);
      logDebugEvent(
        'seek',
        'External seek applied',
        `To ${seekTo.toFixed(1)}s (readyState=${audio.readyState})`,
      );
      if (autoPlayOnSeek && !recordedErrorTakesOverPlay(audio)) {
        userInitiatedRef.current = true;
        safePlay(audio, 'auto-play after external seek', logDebugEvent);
      }
    } else {
      pendingSeekRef.current = { time: seekTo, autoPlay: !!autoPlayOnSeek };
      logDebugEvent(
        'seek',
        'External seek queued',
        `To ${seekTo.toFixed(1)}s (waiting for metadata, readyState=${audio.readyState})`,
      );
      // Metadata never arrives for a source that already failed.
      if (autoPlayOnSeek) recordedErrorTakesOverPlay(audio);
    }
    syncPlayRequest();
  }, [src, hash, seekTo, seekKey, playbackEnd, onTimeUpdate, autoPlayOnSeek, logDebugEvent, dispatchRetry, recordedErrorTakesOverPlay, setCurrentTime, syncPlayRequest]);

  // NOTE: PerformanceObserver was removed because it only fires when HTTP requests complete.
  // For streaming audio, the request stays open until the entire file downloads, so it's not
  // useful for tracking progress. Buffer growth tracking (in updateBasicBufferInfo) is used instead.

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // timeupdate fires only about four times a second, which lets an excerpt
    // run up to a quarter second past its end. While an end is set and audio
    // plays, the end is also checked every frame.
    let endFrame: number | null = null;
    const watchExcerptEnd = () => {
      endFrame = null;
      const end = playbackEndRef.current;
      if (end === null || audio.paused) return;
      if (audio.currentTime >= end) {
        handleTimeUpdate();
        return;
      }
      endFrame = requestAnimationFrame(watchExcerptEnd);
    };
    const stopWatchingExcerptEnd = () => {
      if (endFrame !== null) cancelAnimationFrame(endFrame);
      endFrame = null;
    };

    const handleTimeUpdate = () => {
      const linkedPlaybackEnd = playbackEndRef.current;
      if (
        linkedPlaybackEnd !== null &&
        audio.currentTime >= linkedPlaybackEnd
      ) {
        playbackEndRef.current = null;
        audio.currentTime = linkedPlaybackEnd;
        // A finished excerpt is a deliberate stop, not an interrupted play.
        playIntentRef.current = false;
        setCurrentTime(linkedPlaybackEnd);
        onTimeUpdate?.(linkedPlaybackEnd);
        audio.pause();
        logDebugEvent(
          'pause',
          'Linked excerpt ended',
          `At ${linkedPlaybackEnd.toFixed(1)}s`,
        );
        return;
      }
      // An end set while already playing (a new span picked mid-play) gets
      // no play event, so the frame check starts from here.
      if (linkedPlaybackEnd !== null && endFrame === null && !audio.paused) {
        endFrame = requestAnimationFrame(watchExcerptEnd);
      }
      // While the page is hidden (screen off, app in the background) the
      // clock holds the time display back and catches it up when the page is
      // shown; lastTimeRef and onTimeUpdate still get every update.
      setCurrentTime(audio.currentTime);
      onTimeUpdate?.(audio.currentTime);
      // If timeupdate fires, audio is actually playing - clear buffering state
      if (!audio.paused) {
        setIsBuffering(false);
      }
    };

    const updateDuration = (label: string) => {
      const nextDuration = audio.duration;
      if (!Number.isFinite(nextDuration) || nextDuration <= 0) {
        return;
      }
      setDuration(nextDuration);
      onDurationChange?.(nextDuration);
      logDebugEvent('loaded', label, `Duration: ${nextDuration.toFixed(1)}s`);
    };

    const handleLoadedMetadata = () => {
      handleRecoveryLoadedMetadata();
      // A paused load stops once it has metadata, often before canplay; a
      // play queued below shows its own buffering from the play event.
      if (audio.paused) setIsBuffering(false);
      updateDuration('Metadata loaded');

      // Apply any pending seek that was queued before metadata loaded
      const pendingSeek = pendingSeekRef.current;
      if (pendingSeek) {
        pendingSeekRef.current = null;
        audio.currentTime = pendingSeek.time;
        setCurrentTime(pendingSeek.time);
        onTimeUpdate?.(pendingSeek.time);
        logDebugEvent(
          'seek',
          'Pending seek applied',
          `To ${pendingSeek.time.toFixed(1)}s`,
        );

        // Auto-play if requested
        if (pendingSeek.autoPlay) {
          userInitiatedRef.current = true;
          safePlay(audio, 'auto-play after pending seek', logDebugEvent);
        }
        syncPlayRequest();
      }
    };

    const handleDurationChange = () => {
      updateDuration('Duration updated');
    };

    const handleEnded = () => {
      playIntentRef.current = false;
      setIsPlaying(false);
      onPlayingChange?.(false);
      onEnded?.(Number.isFinite(audio.duration) ? audio.duration : 0);
      syncPlayRequest();
    };

    const handlePlay = () => {
      playIntentRef.current = true;
      setIsPlaying(true);
      // Show spinner immediately if we don't have enough data to play
      // readyState: 0=NOTHING, 1=METADATA, 2=CURRENT_DATA, 3=FUTURE_DATA, 4=ENOUGH_DATA
      if (audio.readyState < 3) {
        setIsBuffering(true);
      }
      onPlayingChange?.(true);
      syncPlayRequest();
      if (playbackEndRef.current !== null && endFrame === null) {
        endFrame = requestAnimationFrame(watchExcerptEnd);
      }
      logDebugEvent(
        'play',
        'Playback started',
        `At ${audio.currentTime.toFixed(1)}s, readyState=${audio.readyState}`,
      );
    };

    const handlePause = () => {
      stopWatchingExcerptEnd();
      setIsPlaying(false);
      setIsBuffering(false); // Clear buffering state when paused
      onPlayingChange?.(false);
      syncPlayRequest();
      logDebugEvent(
        'pause',
        'Playback paused',
        `At ${audio.currentTime.toFixed(1)}s`,
      );
    };

    const handleWaiting = () => {
      setIsBuffering(true);
      logDebugEvent(
        'waiting',
        'Buffering',
        `At ${audio.currentTime.toFixed(1)}s`,
      );
    };

    const handleCanPlay = () => {
      setIsBuffering(false);
      // Clears a shown error; resumes if we're recovering from a network error.
      handleRecoveryCanPlay();
    };

    const handleStalled = () => {
      logDebugEvent(
        'stalled',
        'Stalled',
        `Download stalled at ${audio.currentTime.toFixed(1)}s`,
      );
      // Show spinner if user is trying to play but download is stalled
      if (!audio.paused) {
        setIsBuffering(true);
      }
    };

    const handleSeeking = () => {
      const seekTime = audio.currentTime;
      logDebugEvent('seek', 'Seeking', `To ${seekTime.toFixed(1)}s`);

      // Check if seek position is buffered
      const buffered = audio.buffered;
      let isPositionBuffered = false;
      for (let i = 0; i < buffered.length; i++) {
        if (seekTime >= buffered.start(i) && seekTime < buffered.end(i)) {
          isPositionBuffered = true;
          break;
        }
      }

      // Show spinner immediately if seeking to unbuffered position while trying to play
      if (!audio.paused && !isPositionBuffered) {
        setIsBuffering(true);
        logDebugEvent(
          'seek',
          'Buffering',
          `Position ${seekTime.toFixed(1)}s not buffered`,
        );
      }
    };

    // Progress event fires when buffer actually changes - update debug info immediately
    const handleProgress = () => {
      if (showDebug) {
        updateDebugInfo();
      }
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('waiting', handleWaiting);
    audio.addEventListener('canplay', handleCanPlay);
    audio.addEventListener('playing', handleCanPlay);
    audio.addEventListener('error', handleError);
    audio.addEventListener('progress', handleProgress);
    audio.addEventListener('stalled', handleStalled);
    audio.addEventListener('seeking', handleSeeking);

    return () => {
      stopWatchingExcerptEnd();
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('waiting', handleWaiting);
      audio.removeEventListener('canplay', handleCanPlay);
      audio.removeEventListener('playing', handleCanPlay);
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('progress', handleProgress);
      audio.removeEventListener('stalled', handleStalled);
      audio.removeEventListener('seeking', handleSeeking);
    };
  }, [
    onTimeUpdate,
    onDurationChange,
    onPlayingChange,
    onEnded,
    handleError,
    handleRecoveryCanPlay,
    handleRecoveryLoadedMetadata,
    showDebug,
    logDebugEvent,
    updateDebugInfo,
    setCurrentTime,
    syncPlayRequest,
  ]);

  // Leaving the page detaches the <audio> element, but it keeps its source,
  // so Android goes on showing a media notification that can resume it with
  // no page behind it. Releasing the source ends that. Strict Mode's simulated
  // unmount leaves the element in the document, and is skipped.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    return () => {
      if (audio.isConnected) return;
      audio.removeAttribute('src');
      audio.load();
    };
  }, []);

  const seekFromControls = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (rangeStart !== undefined && rangeEnd !== undefined && rangeEnd <= rangeStart) return;

    if (!Number.isFinite(time)) return;
    time = Math.max(rangeStart ?? 0, rangeEnd !== undefined ? Math.min(rangeEnd, time) : time);
    playbackEndRef.current = rangeEnd ?? null;
    // Interrupt listening coverage before reporting the new position.
    onSeek?.(time);
    // A user seek supersedes a restore still waiting for metadata. Keep its
    // play intent, but never let the old position replace the user's target.
    const pendingSeek = pendingSeekRef.current;
    if (pendingSeek) {
      pendingSeekRef.current = audio.readyState >= 1 ? null : { ...pendingSeek, time };
    } else if (rangeStart !== undefined && audio.readyState < 1) {
      pendingSeekRef.current = { time, autoPlay: playIntentRef.current };
    }
    dispatchRetry({ type: 'SEEK_REQUESTED', time });
    if (rangeStart === undefined || audio.readyState >= 1) audio.currentTime = time;
    setCurrentTime(time);
    if (rangeStart !== undefined) onTimeUpdate?.(time);
    if (audio.readyState >= 1 && pendingSeek?.autoPlay) {
      userInitiatedRef.current = true;
      safePlay(audio, 'auto-play after control seek', logDebugEvent);
    }
    syncPlayRequest();
  }, [rangeStart, rangeEnd, onSeek, onTimeUpdate, dispatchRetry, logDebugEvent, setCurrentTime, syncPlayRequest]);

  // Every play and pause control goes through these two, so a deliberate
  // pause also cancels a play queued for metadata or a reconnect.
  const play = useCallback((end?: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (rangeStart !== undefined && rangeEnd !== undefined && rangeEnd <= rangeStart) return;
    userInitiatedRef.current = true;
    playIntentRef.current = true;
    if (rangeStart !== undefined && rangeEnd !== undefined) {
      const retry = retryStateRef.current;
      const time = pendingSeekRef.current?.time ??
        (retry.phase === 'idle' ? audio.currentTime : retry.savedPosition);
      if (time < rangeStart || time >= rangeEnd) seekFromControls(rangeStart);
      playbackEndRef.current = Math.min(end ?? rangeEnd, rangeEnd);
    } else if (end !== undefined) {
      playbackEndRef.current = resolvePlaybackEnd(end);
    }
    // A failed source that cannot reconnect plays nothing; a reconnect
    // resumes playback below once it recovers.
    if (recordedErrorTakesOverPlay(audio) && !isRetrying(retryStateRef.current)) return;
    // A queued seek still applies its position when metadata arrives.
    if (pendingSeekRef.current) pendingSeekRef.current.autoPlay = true;
    dispatchRetry({ type: 'PLAY_INTENT_CHANGED', playing: true });
    // A reconnect resumes on its own once the connection is back. Otherwise
    // play now, inside the click: browsers that require a user gesture
    // refuse a play started later from loadedmetadata, and some only load
    // the media once play is called.
    if (!isRetrying(retryStateRef.current)) {
      safePlay(audio, 'playback requested', logDebugEvent);
    }
    syncPlayRequest();
  }, [rangeStart, rangeEnd, retryStateRef, seekFromControls, recordedErrorTakesOverPlay, dispatchRetry, logDebugEvent, syncPlayRequest]);

  const pause = useCallback(() => {
    userInitiatedRef.current = true;
    playIntentRef.current = false;
    if (pendingSeekRef.current) pendingSeekRef.current.autoPlay = false;
    dispatchRetry({ type: 'PLAY_INTENT_CHANGED', playing: false });
    audioRef.current?.pause();
    syncPlayRequest();
  }, [dispatchRetry, syncPlayRequest]);

  // Media events remain the source of truth for both sets of controls.
  const togglePlay = useCallback(() => {
    if (rangeStart !== undefined ? isPlayRequested() : isPlaying) pause();
    else play();
  }, [rangeStart, isPlayRequested, isPlaying, play, pause]);

  const handleSeek = (value: number[]) => seekFromControls(value[0]);

  const { volume, isMuted, setVolumeLevel, toggleMute, adjustVolume } = useVolumeControls({
    audioRef,
    cancelSleepFade,
  });
  const handleVolumeChange = (value: number[]) => setVolumeLevel(value[0]);

  const retry = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const time = Math.max(rangeStart ?? 0, rangeEnd !== undefined
      ? Math.min(rangeEnd, relativeSeekBase(audio)) : relativeSeekBase(audio));
    pause();
    playbackEndRef.current = rangeEnd ?? playbackEndRef.current;
    reloadFrom(time);
  };

  const skipBackward = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const time = Math.max(0, relativeSeekBase(audio) - 10);
    seekFromControls(time);
  };

  const skipForward = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const base = relativeSeekBase(audio);
    // Until the duration is known it is 0, which would send playback to the start.
    const time = duration > 0 ? Math.min(duration, base + 10) : base + 10;
    seekFromControls(time);
  };

  // Lock-screen and notification controls drive the same paths as the
  // on-screen buttons, including play/pause being unavailable while reconnecting.
  useMediaSession({
    metadata: mediaMetadata,
    isPlaying,
    onPlay: () => {
      if (!isReconnecting) play();
    },
    onPause: () => {
      if (rangeStart !== undefined || !isReconnecting) pause();
    },
    onSkipBackward: skipBackward,
    onSkipForward: skipForward,
  });

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const audio = audioRef.current;
      if (!audio) return;

      // Don't capture keyboard events when user is typing in an input
      const target = e.target as HTMLElement;
      if (
        e.defaultPrevented ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.closest('[role="slider"]')
      ) {
        return;
      }

      // A page's own playback buttons can keep Space for their native click
      // by sitting inside [data-native-space]; elsewhere Space plays/pauses.
      if (
        e.code === 'Space' &&
        target.closest('button, [role="button"]')?.closest('[data-native-space]')
      ) {
        return;
      }

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekFromControls(Math.max(0, relativeSeekBase(audio) - 5));
          break;
        case 'ArrowRight':
          e.preventDefault();
          {
            // Until the duration is known it is 0, as in skipForward.
            const base = relativeSeekBase(audio);
            seekFromControls(duration > 0 ? Math.min(duration, base + 5) : base + 5);
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          adjustVolume(0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          adjustVolume(-0.1);
          break;
        case 'KeyM':
          e.preventDefault();
          toggleMute();
          break;
      }
    },
    [togglePlay, duration, seekFromControls, relativeSeekBase, adjustVolume, toggleMute],
  );

  // Register keyboard shortcuts
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  useImperativeHandle(ref, () => ({
    play,
    pause,
    getCurrentTime: () => {
      const audio = audioRef.current;
      return audio ? relativeSeekBase(audio) : 0;
    },
    isPlayRequested,
  }), [play, pause, relativeSeekBase, isPlayRequested]);
  // Last among the hooks: the refs the fade touches are still written above.
  useSleepTimerTarget(isPlaying && !isBuffering, sleepFadeOutAndPause, sleepTimerEnabled);

  return (
    <div
      className={renderControls ? undefined : "rounded-lg border border-foreground/35 bg-card p-4"}
      translate="no"
    >
      <audio ref={audioRef} src={src} preload="metadata" />

      {renderControls ? <CustomControls render={renderControls} controls={{
        volume,
        isMuted,
        isBuffering,
        isReconnecting,
        hasError: recovery.hasError,
        seek: seekFromControls,
        setVolume: setVolumeLevel,
        toggleMute,
        retry,
      }} /> : <AudioPlayerChrome
        bufferInfo={bufferInfo}
        catalogId={catalogId}
        clock={timeClock}
        downloadEventId={downloadEventId}
        duration={duration}
        hash={hash}
        isBuffering={isBuffering}
        isDownloaded={cacheStatus === 'complete'}
        isMuted={isMuted}
        isPlaying={isPlaying}
        isReconnecting={isReconnecting}
        markers={markers}
        onBookmark={onBookmark}
        onSeek={handleSeek}
        onSkipBackward={skipBackward}
        onSkipForward={skipForward}
        onToggleDebug={() => setShowDebug((current) => !current)}
        onToggleMute={toggleMute}
        onTogglePlay={togglePlay}
        onVolumeChange={handleVolumeChange}
        showDebug={showDebug}
        sleepTimerEnabled={sleepTimerEnabled}
        volume={volume}
      />}

      {/* Debug info panel */}
      {showDebug && (
        <AudioPlayerDebugPanel
          cacheStatus={cacheStatus}
          diagnostics={diagnostics}
          clock={timeClock}
          debugEvents={debugEvents}
          duration={duration}
          isBuffering={isBuffering}
          src={src}
        />
      )}
    </div>
  );
}
