'use client';

/**
 * Audio Player with Network Resilience
 *
 * This component handles audio playback with automatic recovery from network errors,
 * which is particularly useful during server deployments when active streams are interrupted.
 *
 * ## Network Error Recovery
 *
 * When a network error (MEDIA_ERR_NETWORK) or connection loss (MEDIA_ERR_SRC_NOT_SUPPORTED)
 * occurs during playback:
 *
 * 1. The player saves the current playback position and playing state
 * 2. Shows a pulsing WifiOff icon on the play button (button is disabled)
 * 3. Attempts to reload the audio with exponential backoff:
 *    - Attempt 1: 1 second delay
 *    - Attempt 2: 2 seconds
 *    - Attempt 3: 4 seconds
 *    - ...up to 30 second cap
 * 4. On successful reconnection:
 *    - Seeks to the saved position
 *    - Automatically resumes playback if it was playing
 * 5. After 10 failed attempts (~3 minutes), gives up and returns to normal state
 *
 * ## Testing
 *
 * To test the retry behavior:
 * 1. Start playing audio
 * 2. In DevTools → Network tab, set to "Offline"
 * 3. Observe the WifiOff icon pulsing
 * 4. Go back online - playback should resume automatically
 *
 * Or trigger a server deployment while audio is playing.
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
import { useContentCache } from '@/hooks/use-content-cache';
import { getSavedPlaybackPosition } from '@/lib/playback-position';

export function AudioPlayer({
  src,
  catalogId,
  onTimeUpdate,
  onDurationChange,
  onPlayingChange,
  onEnded,
  seekTo,
  seekKey,
  autoPlayOnSeek,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Extract hash from audio URL for cache management
  const hash = useMemo(() => {
    return extractRecordingHash(src);
  }, [src]);

  // Cache status for buffer indicator (shows full ring when cached)
  const { status: cacheStatus } = useContentCache(hash, src, catalogId ?? null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const {
    bufferInfo,
    chunkFetches,
    debugInfo,
    reset: resetBufferDiagnostics,
    updateDebugInfo,
  } = useAudioBufferDiagnostics({ audioRef, debugEnabled: showDebug, src });
  const userInitiatedRef = useRef(false);

  // Background event log - always collects events even when debug is off
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);
  const debugEventIdRef = useRef(0);

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

  // Network error retry state — lives in a single reducer, see retryReducer
  // above. `isReconnecting` is derived.
  const [retryState, reactDispatchRetry] = useReducer(
    retryReducer,
    INITIAL_RETRY_STATE,
  );
  const isReconnecting = isRetrying(retryState);
  const prevSrcRef = useRef(src); // Track previous src for change detection
  const prevCacheStatusRef = useRef(cacheStatus); // Track cache status for reload on complete
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

  // Handle external seek requests - sync React state with audio element
  // Must wait for metadata to load before seeking, otherwise seek is silently ignored
  useEffect(() => {
    const audio = audioRef.current;
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

        // Auto-play after seek if requested (used for radio handoff)
        if (autoPlayOnSeek) {
          userInitiatedRef.current = true;
          safePlay(audio, 'auto-play after external seek', logDebugEvent);
        }
      } else {
        // Metadata not loaded yet - queue the seek for when it loads
        pendingSeekRef.current = { time: seekTo, autoPlay: !!autoPlayOnSeek };
        logDebugEvent(
          'seek',
          'External seek queued',
          `To ${seekTo.toFixed(1)}s (waiting for metadata, readyState=${audio.readyState})`,
        );
      }
    }
  }, [seekTo, seekKey, onTimeUpdate, autoPlayOnSeek, logDebugEvent]);

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

  // Reset state when audio source changes (not on initial mount)
  useEffect(() => {
    // Skip on initial mount - only run when src actually changes
    const previousSrc = prevSrcRef.current;
    if (previousSrc === src) {
      return;
    }
    const previousHash = extractRecordingHash(previousSrc);
    const nextHash = extractRecordingHash(src);
    const sameRecording =
      !!previousHash && !!nextHash && previousHash === nextHash;

    prevSrcRef.current = src;

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
        } else if (audio.currentTime > 0 || !audio.paused) {
          restoreAfterSourceSwitch = {
            time: audio.currentTime,
            autoPlay: !audio.paused,
          };
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
      setDebugEvents([]);
      onPlayingChange?.(false);
    });
  }, [src, onPlayingChange, dispatchRetry, resetBufferDiagnostics]);

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
        wasPlaying: !audio.paused,
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
      setIsPlaying(false);
      onPlayingChange?.(false);
      onEnded?.(Number.isFinite(audio.duration) ? audio.duration : 0);
    };

    const handlePlay = () => {
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

  // Reload the audio element when caching completes so playback switches from
  // the network stream to SW cache. If `src` changes before loadedmetadata
  // fires (e.g. user navigates to another recording), the cleanup removes the
  // restorePosition listener so we never apply the old position to the new
  // src.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const prevStatus = prevCacheStatusRef.current;
    prevCacheStatusRef.current = cacheStatus;

    if (prevStatus !== 'caching' || cacheStatus !== 'cached') return;

    // Don't collide with a retry-in-flight. The retry effect already owns
    // the audio element and will call audio.load() itself; a second load()
    // here would cancel the retry mid-load and duplicate restorePosition
    // logic. After RECOVERED, subsequent range requests go through the SW
    // and pick up the cached data naturally.
    if (
      retryStateRef.current.phase === 'scheduled' ||
      retryStateRef.current.phase === 'reloading'
    ) {
      logDebugEvent(
        'loaded',
        'Cache complete',
        'Retry in flight; skipping cache-reload to avoid collision',
      );
      return;
    }

    const wasPlaying = !audio.paused;
    const position = audio.currentTime;

    logDebugEvent(
      'loaded',
      'Cache complete',
      'Reloading audio to use cached data',
    );

    audio.load();

    const restorePosition = () => {
      audio.removeEventListener('loadedmetadata', restorePosition);
      if (position > 0) {
        audio.currentTime = position;
      }
      if (wasPlaying) {
        safePlay(audio, 'cache-complete resume', logDebugEvent);
      }
    };
    audio.addEventListener('loadedmetadata', restorePosition);

    return () => {
      audio.removeEventListener('loadedmetadata', restorePosition);
    };
  }, [cacheStatus, src, logDebugEvent]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    // Let audio element events update state (handlePlay/handlePause callbacks)
    // This ensures consistent behavior between button clicks and keyboard shortcuts
    userInitiatedRef.current = true;
    if (isPlaying) {
      audio.pause();
    } else {
      safePlay(audio, 'toggle play button', logDebugEvent);
    }
  };

  const handleSeek = (value: number[]) => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.currentTime = value[0];
    setCurrentTime(value[0]);
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

  const skipBackward = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, audio.currentTime - 10);
  };

  const skipForward = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.min(duration, audio.currentTime + 10);
  };

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const audio = audioRef.current;
      if (!audio) return;

      // Don't capture keyboard events when user is typing in an input
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          userInitiatedRef.current = true;
          if (isPlaying) {
            audio.pause();
          } else {
            safePlay(audio, 'space keyboard shortcut', logDebugEvent);
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          audio.currentTime = Math.max(0, audio.currentTime - 5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          audio.currentTime = Math.min(duration, audio.currentTime + 5);
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
    [isPlaying, duration, volume, isMuted, logDebugEvent],
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
        cacheStatus={cacheStatus}
        catalogId={catalogId}
        currentTime={currentTime}
        duration={duration}
        hash={hash}
        isBuffering={isBuffering}
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
        src={src}
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
        />
      )}
    </div>
  );
}

// Expose a method to seek from outside the component
AudioPlayer.seek = (audioElement: HTMLAudioElement | null, time: number) => {
  if (audioElement) {
    audioElement.currentTime = time;
  }
};
