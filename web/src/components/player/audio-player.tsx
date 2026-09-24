'use client';

/**
 * Audio player for one recording.
 *
 * The visible controls live in AudioPlayerChrome; this component owns the
 * media element and three behaviours around it:
 *
 * - Source switches for the same recording. The page hands the player a
 *   network URL first and, once a download completes, the local package URL
 *   (or an inline copy on browsers that need it). The switch is a real
 *   source change; position and play intent carry across it.
 * - Recovery from network errors while streaming a recording that is not
 *   downloaded: exponential retries that reload the element, then restore
 *   position and resume when the listener had asked for playback.
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
  useReducer,
} from 'react';
import { AudioPlayerChrome } from './audio-player-chrome';
import { AudioPlayerDebugPanel } from './audio-player-debug-panel';
import { describeAudioSource } from '@/lib/offline/audio-transport';
import {
  INITIAL_RETRY_STATE,
  isRetrying,
  retryReducer,
  type RetryAction,
  type RetryState,
} from './audio-player-retry-state';
import type {
  AudioPlayerProps,
  DebugEvent,
  DebugEventType,
} from './audio-player-types';
import {
  extractRecordingHash,
  MAX_RETRY_ATTEMPTS,
  safePlay,
} from './audio-player-utils';
import { useAudioBufferDiagnostics } from './use-audio-buffer-diagnostics';
import { useMediaSession } from './use-media-session';
import { useDownloadRecord } from '@/hooks/use-downloads';
import { getSavedPlaybackPosition } from '@/lib/playback-position';

function resolvePlaybackEnd(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** The log entry naming the transport behind a source. */
function createSourceEvent(id: number, src: string): DebugEvent {
  const source = describeAudioSource(src);
  return {
    id,
    timestamp: new Date(),
    type: 'source',
    message: `Source: ${source.kind}`,
    details: source.summary,
  };
}

export function AudioPlayer({
  src,
  recordingHash,
  catalogId,
  downloadEventId,
  onTimeUpdate,
  onDurationChange,
  onPlayingChange,
  onSeek,
  onEnded,
  seekTo,
  seekKey,
  playbackEnd,
  autoPlayOnSeek,
  mediaMetadata,
  launchNote,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // The recording identity drives download state; fall back to the API URL
  // shape when the caller did not name it.
  const hash = useMemo(() => {
    return recordingHash ?? extractRecordingHash(src);
  }, [recordingHash, src]);

  // Download state feeds the cached indicator and the debug panel; the switch
  // to local playback itself arrives as a new src from the page.
  const downloadRecord = useDownloadRecord(catalogId ?? null, hash);
  const cacheStatus = downloadRecord?.status ?? 'none';

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  // Counts seeks so the media session republishes its position state.
  const [seekVersion, setSeekVersion] = useState(0);
  const {
    bufferInfo,
    chunkFetches,
    debugInfo,
    reset: resetBufferDiagnostics,
    updateDebugInfo,
  } = useAudioBufferDiagnostics({ audioRef, debugEnabled: showDebug, src });
  const userInitiatedRef = useRef(false);
  const playbackEndRef = useRef<number | null>(
    resolvePlaybackEnd(playbackEnd),
  );

  useEffect(() => {
    playbackEndRef.current = resolvePlaybackEnd(playbackEnd);
  }, [playbackEnd]);

  // Background event log - always collects events even when debug is off.
  // It opens with the initial source's transport; the source-change effect
  // below skips the mount, so that entry is created here.
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>(() => [
    createSourceEvent(0, src),
  ]);
  const debugEventIdRef = useRef(1);

  const logDebugEvent = useCallback(
    (type: DebugEventType, message: string, details?: string) => {
      const event: DebugEvent = {
        id: debugEventIdRef.current++,
        timestamp: new Date(),
        type,
        message,
        details,
      };
      // Keep last 50 events
      setDebugEvents((prev) => [...prev.slice(-49), event]);
    },
    [],
  );

  // The page's launch note arrives whenever its effect runs, which may be
  // after this player mounted from cached data; log it once either way, so a
  // relaunch after a kill can be read on the device.
  const launchNoteLoggedRef = useRef(false);
  useEffect(() => {
    if (!launchNote || launchNoteLoggedRef.current) return;
    launchNoteLoggedRef.current = true;
    logDebugEvent('lifecycle', 'Launch', launchNote);
  }, [launchNote, logDebugEvent]);

  // Network error retry state — lives in a single reducer, see retryReducer
  // above. `isReconnecting` is derived.
  const [retryState, reactDispatchRetry] = useReducer(
    retryReducer,
    INITIAL_RETRY_STATE,
  );
  const isReconnecting = isRetrying(retryState);
  const prevSrcRef = useRef(src); // Track previous src for change detection
  const prevRecordingHashRef = useRef(recordingHash);
  // Last playback position React observed; survives the element reset that a
  // src change performs before effects run.
  const lastTimeRef = useRef(0);
  // Whether the listener wants playback. The browser pauses the element
  // before it reports a media error, so `audio.paused` alone cannot tell an
  // interrupted play from a deliberate pause when deciding to resume.
  const playIntentRef = useRef(false);
  // Tracks whether metadata has loaded successfully for the current src.
  // Used to avoid retry-looping on MEDIA_ERR_SRC_NOT_SUPPORTED when the format
  // is genuinely unplayable (vs. a network blip mid-stream).
  const metadataLoadedRef = useRef(false);
  // Held in a ref so event handlers (attached once via useEffect deps) can read
  // the latest phase WITHOUT waiting for React to commit the reducer state.
  // Updated synchronously by `dispatchRetry` below so there's no lag window
  // between a dispatch and a handler observing the new phase.
  const retryStateRef = useRef<RetryState>(INITIAL_RETRY_STATE);
  // Pending retry timer. Held in a ref (not the retry-driving effect's local
  // closure) so it can be cancelled synchronously from any transition out of
  // `scheduled` — RECOVERED, RESET, RELOAD_FAILED — without waiting for React
  // to re-run the effect.
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);
  // The audio.src value that was in effect when the retry chain started.
  // React commits a new src before our src-change useEffect runs and dispatches
  // RESET, so there's a window where the retry timer/state still looks active
  // but is referring to the previous recording. Every retry-time decision
  // (timer fire, canplay recovery) compares this against the current audio.src
  // and bails if they differ, closing that window.
  const retrySrcRef = useRef<string | null>(null);
  const dispatchRetry = useCallback(
    (action: RetryAction) => {
      // Any action that exits the retry chain must kill a pending timer
      // immediately; otherwise an already-queued callback can still fire and
      // call audio.load() on an element that's recovered or switched src.
      if (
        action.type === 'RESET' ||
        action.type === 'RECOVERED' ||
        action.type === 'RELOAD_FAILED'
      ) {
        cancelRetryTimer();
      }
      // RESET/RECOVERED also invalidate the captured src (we're leaving the
      // chain entirely). RELOAD_FAILED keeps it because the retry continues
      // against the same source.
      if (action.type === 'RESET' || action.type === 'RECOVERED') {
        retrySrcRef.current = null;
      }
      retryStateRef.current = retryReducer(retryStateRef.current, action);
      reactDispatchRetry(action);
    },
    [cancelRetryTimer],
  );

  // Pending seek - stores seek request until metadata is loaded
  const pendingSeekRef = useRef<{ time: number; autoPlay: boolean } | null>(
    null,
  );

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

    const savedPosition = getSavedPlaybackPosition(hash);
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
  }, [hash, onTimeUpdate, logDebugEvent]);

  // Read by the seek effect below without being one of its dependencies: the
  // page clears the flag once playback starts, and that must not re-apply the
  // seek to an element that is already playing.
  const autoPlayOnSeekRef = useRef(!!autoPlayOnSeek);
  useEffect(() => {
    autoPlayOnSeekRef.current = !!autoPlayOnSeek;
  }, [autoPlayOnSeek]);

  // Handle external seek requests - sync React state with audio element
  // Must wait for metadata to load before seeking, otherwise seek is silently ignored
  useEffect(() => {
    const audio = audioRef.current;
    const autoPlay = autoPlayOnSeekRef.current;
    if (audio && seekTo !== undefined && seekTo >= 0) {
      // Check if audio has metadata loaded (readyState >= 1 = HAVE_METADATA)
      if (audio.readyState >= 1) {
        // Metadata loaded - seek immediately
        audio.currentTime = seekTo;
        // Sync React state with audio element - intentional for controlled seek
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setCurrentTime(seekTo);
        onTimeUpdate?.(seekTo);
        logDebugEvent(
          'seek',
          'External seek applied',
          `To ${seekTo.toFixed(1)}s (readyState=${audio.readyState})`,
        );

        // Auto-play after seek if requested (radio handoff, interrupted session)
        if (autoPlay) {
          userInitiatedRef.current = true;
          safePlay(audio, 'auto-play after external seek', logDebugEvent);
        }
      } else {
        // Metadata not loaded yet - queue the seek for when it loads
        pendingSeekRef.current = { time: seekTo, autoPlay };
        logDebugEvent(
          'seek',
          'External seek queued',
          `To ${seekTo.toFixed(1)}s (waiting for metadata, readyState=${audio.readyState})`,
        );
      }
    }
  }, [seekTo, seekKey, onTimeUpdate, logDebugEvent]);

  // Drive the retry machine. When phase transitions to "scheduled", schedule
  // the reload; when it transitions to "exhausted", log and clear transient
  // UI state. The timer itself lives in `retryTimerRef` so it can be
  // cancelled synchronously from `dispatchRetry` on RESET/RECOVERED/
  // RELOAD_FAILED — see the wrapper above. The callback also re-reads the
  // phase via the ref and bails if it's moved out of "scheduled", which
  // closes the window between a cancel on a different tick and a timer that
  // was already about to fire.
  useEffect(() => {
    let cancelled = false;

    if (retryState.phase === 'scheduled') {
      const audio = audioRef.current;
      if (!audio) return;

      logDebugEvent(
        'retry',
        `Retry attempt ${retryState.attempt}`,
        `Waiting ${retryState.delayMs}ms`,
      );

      cancelRetryTimer();
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (retryStateRef.current.phase !== 'scheduled') return;
        // If src changed since we started retrying, bail — otherwise we'd
        // issue audio.load() against the new recording.
        if (retrySrcRef.current !== null && audio.src !== retrySrcRef.current) {
          return;
        }
        dispatchRetry({ type: 'TIMER_FIRED' });
        audio.load();
      }, retryState.delayMs);

      return () => cancelRetryTimer();
    }

    if (retryState.phase === 'exhausted') {
      logDebugEvent(
        'error',
        'Max retries reached',
        `Gave up after ${MAX_RETRY_ATTEMPTS} attempts`,
      );
      queueMicrotask(() => {
        if (cancelled) return;
        // Old resetRetryState() used to clear the buffering spinner here.
        // Without this, the player can sit on an "exhausted" phase with
        // isBuffering=true (set earlier by 'waiting' during a failed load)
        // and show the spinner forever.
        setIsBuffering(false);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [retryState, logDebugEvent, cancelRetryTimer, dispatchRetry]);

  useEffect(() => {
    const handlePageShow = () => {
      restoreSavedPositionAfterResume();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        restoreSavedPositionAfterResume();
      }
    };

    window.addEventListener('pageshow', handlePageShow);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('pageshow', handlePageShow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [restoreSavedPositionAfterResume]);

  // Page lifecycle in the event log. Whether `pagehide` fires when the app is
  // swiped away decides if a later launch counts as interrupted, so it has to
  // be observable on a phone.
  useEffect(() => {
    const describeElement = () => {
      const audio = audioRef.current;
      if (!audio) return undefined;
      return `At ${audio.currentTime.toFixed(1)}s, ${audio.paused ? 'paused' : 'playing'}`;
    };
    const handleVisibility = () => {
      logDebugEvent(
        'lifecycle',
        document.visibilityState === 'hidden' ? 'Page hidden' : 'Page visible',
        describeElement(),
      );
    };
    const handlePageHide = (event: PageTransitionEvent) => {
      logDebugEvent(
        'lifecycle',
        'Page hide',
        event.persisted ? 'Kept for back-forward cache' : 'Unloading',
      );
    };
    const handleFreeze = () => logDebugEvent('lifecycle', 'Page frozen', describeElement());
    const handleResume = () => logDebugEvent('lifecycle', 'Page resumed', describeElement());

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('freeze', handleFreeze);
    document.addEventListener('resume', handleResume);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('freeze', handleFreeze);
      document.removeEventListener('resume', handleResume);
    };
  }, [logDebugEvent]);

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

    // Reset retry machine. The retry-driving effect watches for this and
    // cancels any in-flight setTimeout via its cleanup.
    dispatchRetry({ type: 'RESET' });
    metadataLoadedRef.current = false;

    // Preserve seek target/position when only switching source variants for the same recording.
    const queuedSeek = pendingSeekRef.current;
    let restoreAfterSourceSwitch: { time: number; autoPlay: boolean } | null =
      null;

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

    // Reset UI state - deferred to avoid synchronous setState in effect body
    queueMicrotask(() => {
      setIsBuffering(false);
      setCurrentTime(restoreAfterSourceSwitch?.time ?? 0);
      setDuration(0);
      setIsPlaying(false);
      resetBufferDiagnostics();
      // The fresh log opens with this source's transport, so a later stall or
      // error is attributable to the network, the worker cache or inline data.
      setDebugEvents([createSourceEvent(debugEventIdRef.current++, src)]);
      onPlayingChange?.(false);
    });
  }, [src, recordingHash, onPlayingChange, dispatchRetry, resetBufferDiagnostics]);

  useEffect(() => {
    lastTimeRef.current = currentTime;
  }, [currentTime]);

  // NOTE: PerformanceObserver was removed because it only fires when HTTP requests complete.
  // For streaming audio, the request stays open until the entire file downloads, so it's not
  // useful for tracking progress. Buffer growth tracking (in updateBasicBufferInfo) is used instead.

  // Handle `error` events — dispatch the retry reducer. The scheduling and
  // reload itself live in the retry-driving effect above.
  const handleError = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const error = audio.error;
    if (!error) return;

    const phase = retryStateRef.current.phase;

    // Suppress speculative preload errors when we're not actively retrying —
    // either because we haven't started (idle) or because we already gave up
    // (exhausted). Without covering "exhausted", a post-giveup metadata probe
    // error would kick off a fresh 10-attempt chain that the reducer's dedup
    // doesn't catch (ERROR_DETECTED dedup only applies to scheduled/reloading).
    if (
      !userInitiatedRef.current &&
      !isPlaying &&
      (phase === 'idle' || phase === 'exhausted')
    ) {
      setIsBuffering(false);
      return;
    }

    // If we're already retrying, the error is from our own retry's
    // audio.load() — advance the retry chain regardless of error code. The
    // retriability check only governs whether a *fresh* error should start a
    // retry chain; once we're in flight, any failure here must move the state
    // machine forward (next attempt or exhausted) or isReconnecting never
    // clears.
    if (phase === 'reloading') {
      logDebugEvent(
        'error',
        'Reload failed',
        `Code: ${error.code}, Message: ${error.message || 'none'}`,
      );
      dispatchRetry({ type: 'RELOAD_FAILED' });
      setIsPlaying(false);
      onPlayingChange?.(false);
      return;
    }

    // MEDIA_ERR_NETWORK = 2 (network error during loading)
    const isNetworkError = error.code === 2;

    // MEDIA_ERR_SRC_NOT_SUPPORTED = 4 can indicate either a genuinely
    // unplayable format OR a mid-stream connection loss. Only start a retry
    // chain when metadata previously loaded for this src — that proves the
    // format is supported and the error is transient. Otherwise retrying
    // burns ~3 minutes of exponential backoff on something that will never
    // play.
    const isSrcError =
      error.code === 4 &&
      audio.src &&
      audio.src !== '' &&
      metadataLoadedRef.current &&
      (typeof navigator === 'undefined' || navigator.onLine !== false);

    if (isNetworkError || isSrcError) {
      const errorType = isNetworkError ? 'Network error' : 'Source error';
      logDebugEvent(
        'error',
        errorType,
        `Code: ${error.code}, Message: ${error.message || 'none'}`,
      );
      // Capture the src we're retrying for. Guards in the timer and canplay
      // handlers compare against audio.src so a pending retry can't leak
      // onto a newly-selected recording during the pre-RESET commit window.
      retrySrcRef.current = audio.src;
      dispatchRetry({
        type: 'ERROR_DETECTED',
        savedPosition: audio.currentTime || 0,
        wasPlaying: !audio.paused || playIntentRef.current,
      });
      setIsPlaying(false);
      onPlayingChange?.(false);
    } else {
      logDebugEvent(
        'error',
        'Media error',
        `Code: ${error.code}, Message: ${error.message || 'none'}`,
      );
    }
  }, [dispatchRetry, isPlaying, onPlayingChange, logDebugEvent]);

  // Handle `canplay` events mid-retry. This covers both:
  //   - "reloading": our scheduled retry's audio.load() finished successfully.
  //   - "scheduled": the browser/network auto-recovered before our timer even
  //     fired. Treat that as success too instead of waiting it out.
  const handleCanPlayAfterError = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const phase = retryStateRef.current;
    if (phase.phase !== 'scheduled' && phase.phase !== 'reloading') return;

    // Stale-canplay guard: after src changes, the browser emits canplay for
    // the new recording. If retry state still carries the previous src (the
    // RESET useEffect hasn't committed yet), applying savedPosition/wasPlaying
    // would leak recording A's resume state onto recording B. Bail.
    if (retrySrcRef.current !== null && audio.src !== retrySrcRef.current) {
      return;
    }

    logDebugEvent(
      'recovered',
      'Connection recovered',
      `After ${phase.attempt} attempt(s)`,
    );

    if (phase.savedPosition > 0) {
      audio.currentTime = phase.savedPosition;
      setCurrentTime(phase.savedPosition);
    }
    if (phase.wasPlaying) {
      safePlay(audio, 'resume after reconnect', logDebugEvent);
    }

    dispatchRetry({ type: 'RECOVERED' });
    setIsBuffering(false);
  }, [dispatchRetry, logDebugEvent]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

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
      metadataLoadedRef.current = true;
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
      logDebugEvent(
        'play',
        'Playback started',
        `At ${audio.currentTime.toFixed(1)}s, readyState=${audio.readyState}`,
      );
    };

    const handlePause = () => {
      setIsPlaying(false);
      setIsBuffering(false); // Clear buffering state when paused
      onPlayingChange?.(false);
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
      // Check if we're recovering from a network error
      handleCanPlayAfterError();
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
      setSeekVersion((version) => version + 1);
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
    handleCanPlayAfterError,
    showDebug,
    logDebugEvent,
    updateDebugInfo,
  ]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    // Let audio element events update state (handlePlay/handlePause callbacks)
    // This ensures consistent behavior between button clicks and keyboard shortcuts
    userInitiatedRef.current = true;
    if (isPlaying) {
      playIntentRef.current = false;
      audio.pause();
    } else {
      safePlay(audio, 'toggle play button', logDebugEvent);
    }
  };

  const handleSeek = (value: number[]) => {
    const audio = audioRef.current;
    if (!audio) return;

    playbackEndRef.current = null;
    audio.currentTime = value[0];
    setCurrentTime(value[0]);
    onSeek?.(value[0]);
  };

  const handleVolumeChange = (value: number[]) => {
    const audio = audioRef.current;
    if (!audio) return;

    const newVolume = value[0];
    audio.volume = newVolume;
    setVolume(newVolume);
    setIsMuted(newVolume === 0);
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isMuted) {
      audio.volume = volume || 1;
      setIsMuted(false);
    } else {
      audio.volume = 0;
      setIsMuted(true);
    }
  };

  const seekBy = (offsetSec: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    playbackEndRef.current = null;
    const time =
      offsetSec < 0
        ? Math.max(0, audio.currentTime + offsetSec)
        : Math.min(duration, audio.currentTime + offsetSec);
    audio.currentTime = time;
    setCurrentTime(time);
    onSeek?.(time);
  };

  const skipBackward = () => seekBy(-10);
  const skipForward = () => seekBy(10);

  // Lock-screen and notification controls drive the same paths as the
  // on-screen buttons, so the page sees every play, pause and seek.
  useMediaSession({
    audioRef,
    metadata: mediaMetadata,
    isPlaying,
    duration,
    seekVersion,
    onPlay: () => {
      const audio = audioRef.current;
      if (!audio) return;
      userInitiatedRef.current = true;
      safePlay(audio, 'media session play', logDebugEvent);
    },
    onPause: () => {
      const audio = audioRef.current;
      if (!audio) return;
      playIntentRef.current = false;
      audio.pause();
    },
    onSeekBy: seekBy,
    onSeekTo: (time) => handleSeek([time]),
    onLog: (message, details) => logDebugEvent('session', message, details),
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

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          userInitiatedRef.current = true;
          if (isPlaying) {
            playIntentRef.current = false;
            audio.pause();
          } else {
            safePlay(audio, 'space keyboard shortcut', logDebugEvent);
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          playbackEndRef.current = null;
          audio.currentTime = Math.max(0, audio.currentTime - 5);
          setCurrentTime(audio.currentTime);
          onSeek?.(audio.currentTime);
          break;
        case 'ArrowRight':
          e.preventDefault();
          playbackEndRef.current = null;
          audio.currentTime = Math.min(duration, audio.currentTime + 5);
          setCurrentTime(audio.currentTime);
          onSeek?.(audio.currentTime);
          break;
        case 'ArrowUp':
          e.preventDefault();
          audio.volume = Math.min(1, audio.volume + 0.1);
          setVolume(audio.volume);
          setIsMuted(false);
          break;
        case 'ArrowDown':
          e.preventDefault();
          audio.volume = Math.max(0, audio.volume - 0.1);
          setVolume(audio.volume);
          if (audio.volume === 0) setIsMuted(true);
          break;
        case 'KeyM':
          e.preventDefault();
          if (isMuted) {
            audio.volume = volume || 1;
            setIsMuted(false);
          } else {
            audio.volume = 0;
            setIsMuted(true);
          }
          break;
      }
    },
    [isPlaying, duration, volume, isMuted, logDebugEvent, onSeek],
  );

  // Register keyboard shortcuts
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  return (
    <div
      className="rounded-lg border border-foreground/35 bg-card p-4"
      translate="no"
    >
      <audio ref={audioRef} src={src} preload="metadata" />

      <AudioPlayerChrome
        bufferInfo={bufferInfo}
        catalogId={catalogId}
        downloadEventId={downloadEventId}
        currentTime={currentTime}
        duration={duration}
        hash={hash}
        isBuffering={isBuffering}
        isDownloaded={cacheStatus === 'complete'}
        isMuted={isMuted}
        isPlaying={isPlaying}
        isReconnecting={isReconnecting}
        onSeek={handleSeek}
        onSkipBackward={skipBackward}
        onSkipForward={skipForward}
        onToggleDebug={() => setShowDebug((current) => !current)}
        onToggleMute={toggleMute}
        onTogglePlay={togglePlay}
        onVolumeChange={handleVolumeChange}
        showDebug={showDebug}
        volume={volume}
      />

      {/* Debug info panel */}
      {showDebug && (
        <AudioPlayerDebugPanel
          cacheStatus={cacheStatus}
          chunkFetches={chunkFetches}
          currentTime={currentTime}
          debugEvents={debugEvents}
          debugInfo={debugInfo}
          duration={duration}
          isBuffering={isBuffering}
          src={src}
        />
      )}
    </div>
  );
}
