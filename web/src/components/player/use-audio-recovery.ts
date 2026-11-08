/**
 * Recovery from network errors while streaming, and the error state the
 * controls show.
 *
 * Exponential retries reload the element, then restore the position and
 * resume when the listener had asked for playback. The retry chain is a
 * reducer (see audio-player-retry-state.ts); this hook drives its timer,
 * feeds it the element's `error` and `canplay` events, and derives from it
 * whether playback is wanted right now, which the page's own controls need
 * to know.
 *
 * The player keeps the refs the whole player shares (the queued seek, the
 * listener's play intent, whether they touched a control) and hands them in.
 */

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  INITIAL_RETRY_STATE,
  isRetrying,
  retryReducer,
  type RetryAction,
  type UnstampedRetryAction,
  type RetryState,
} from './audio-player-retry-state';
import type { DebugEventType } from './audio-player-types';
import { MAX_RETRY_ATTEMPTS, safePlay } from './audio-player-utils';

export interface PendingSeek {
  time: number;
  autoPlay: boolean;
}

/** Refs the player owns and every behaviour around the element reads. */
export interface PlaybackIntentRefs {
  /** A seek waiting for metadata, and whether to play once it applies. */
  pendingSeekRef: RefObject<PendingSeek | null>;
  /**
   * Whether the listener wants playback. The browser pauses the element
   * before it reports a media error, so `audio.paused` alone cannot tell an
   * interrupted play from a deliberate pause when deciding to resume.
   */
  playIntentRef: RefObject<boolean>;
  /** Whether the listener has operated a control since the source was set. */
  userInitiatedRef: RefObject<boolean>;
}

export function useAudioRecovery({
  audioRef,
  intent,
  isPlaying,
  logDebugEvent,
  setCurrentTime,
  setIsBuffering,
  onPlaybackInterrupted,
  onPlayRequestChange,
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  intent: PlaybackIntentRefs;
  isPlaying: boolean;
  logDebugEvent: (type: DebugEventType, message: string, details?: string) => void;
  setCurrentTime: (time: number) => void;
  setIsBuffering: (buffering: boolean) => void;
  /** An error stopped playback; the player reports it as not playing. */
  onPlaybackInterrupted: () => void;
  onPlayRequestChange: ((requested: boolean) => void) | undefined;
}) {
  const { pendingSeekRef, playIntentRef, userInitiatedRef } = intent;
  // A media error that is not retried: the controls offer Retry.
  const [hasMediaError, setHasMediaError] = useState(false);

  // Network error retry state lives in a single reducer, see retryReducer.
  // `isReconnecting` is derived.
  const [retryState, reactDispatchRetry] = useReducer(
    retryReducer,
    INITIAL_RETRY_STATE,
  );
  const isReconnecting = isRetrying(retryState);
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
  // React commits a new src before the player's src-change useEffect runs and
  // dispatches RESET, so there's a window where the retry timer/state still
  // looks active but is referring to the previous recording. Every retry-time
  // decision (timer fire, canplay recovery) compares this against the current
  // audio.src and bails if they differ, closing that window.
  const retrySrcRef = useRef<string | null>(null);
  const retryScheduleCounterRef = useRef(0);

  // Whether playback is wanted right now: playing, queued until metadata
  // arrives, or held by a reconnect that will resume it. Reported to the page
  // whenever it changes, so controls outside the player can show what a
  // click on them will do.
  const isPlayRequested = useCallback(() => {
    const audio = audioRef.current;
    return Boolean(
      (isRetrying(retryStateRef.current) && playIntentRef.current) ||
      pendingSeekRef.current?.autoPlay ||
      (audio && !audio.paused),
    );
  }, [audioRef, pendingSeekRef, playIntentRef]);
  const onPlayRequestChangeRef = useRef(onPlayRequestChange);
  useEffect(() => {
    onPlayRequestChangeRef.current = onPlayRequestChange;
  }, [onPlayRequestChange]);
  const playRequestedRef = useRef(false);
  const syncPlayRequest = useCallback(() => {
    const requested = isPlayRequested();
    if (requested === playRequestedRef.current) return;
    playRequestedRef.current = requested;
    onPlayRequestChangeRef.current?.(requested);
  }, [isPlayRequested]);

  const dispatchRetry = useCallback(
    (action: UnstampedRetryAction) => {
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
      // Actions that may start a schedule carry a fresh id; see scheduleId.
      const stamped: RetryAction =
        action.type === 'ERROR_DETECTED' || action.type === 'RELOAD_FAILED'
          ? { ...action, scheduleId: ++retryScheduleCounterRef.current }
          : action;
      retryStateRef.current = retryReducer(retryStateRef.current, stamped);
      reactDispatchRetry(stamped);
      syncPlayRequest();
    },
    [cancelRetryTimer, syncPlayRequest],
  );

  // Drive the retry machine. When phase transitions to "scheduled", schedule
  // the reload; when it transitions to "exhausted", log and clear transient
  // UI state. The timer itself lives in `retryTimerRef` so it can be
  // cancelled synchronously from `dispatchRetry` on RESET/RECOVERED/
  // RELOAD_FAILED — see the wrapper above. The callback also re-reads the
  // phase via the ref and bails if it's moved out of "scheduled", which
  // closes the window between a cancel on a different tick and a timer that
  // was already about to fire.
  // A seek changes the restore target, not the deadline of a scheduled retry;
  // a new schedule always has a new scheduleId, so the timer is re-armed.
  const retryAttempt = 'attempt' in retryState ? retryState.attempt : 0;
  const retryDelayMs = retryState.phase === 'scheduled' ? retryState.delayMs : 0;
  const retryScheduleId = retryState.phase === 'scheduled' ? retryState.scheduleId : 0;
  useEffect(() => {
    let cancelled = false;

    if (retryState.phase === 'scheduled') {
      const audio = audioRef.current;
      if (!audio) return;

      logDebugEvent(
        'retry',
        `Retry attempt ${retryAttempt}`,
        `Waiting ${retryDelayMs}ms`,
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
      }, retryDelayMs);

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
        // Without this, the player can sit on an "exhausted" phase with
        // isBuffering=true (set earlier by 'waiting' during a failed load)
        // and show the spinner forever.
        setIsBuffering(false);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [
    audioRef,
    retryState.phase,
    retryAttempt,
    retryDelayMs,
    retryScheduleId,
    logDebugEvent,
    cancelRetryTimer,
    dispatchRetry,
    setIsBuffering,
  ]);

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
      onPlaybackInterrupted();
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
      // A seek still waiting for metadata is the position to restore; the
      // element itself reports 0 until metadata arrives.
      dispatchRetry({
        type: 'ERROR_DETECTED',
        savedPosition: pendingSeekRef.current?.time ?? (audio.currentTime || 0),
        wasPlaying: !audio.paused || playIntentRef.current,
      });
      onPlaybackInterrupted();
    } else {
      setHasMediaError(true);
      setIsBuffering(false);
      logDebugEvent(
        'error',
        'Media error',
        `Code: ${error.code}, Message: ${error.message || 'none'}`,
      );
    }
  }, [
    audioRef,
    dispatchRetry,
    isPlaying,
    logDebugEvent,
    onPlaybackInterrupted,
    pendingSeekRef,
    playIntentRef,
    setIsBuffering,
    userInitiatedRef,
  ]);

  // An error during the unattended preload was left alone (see handleError),
  // and the element does not report it again: play() does not reload a failed
  // element. Every playback the listener asks for, from the play control or a
  // seek that plays, hands that error to handleError first: a network error
  // reconnects and then plays, anything else offers Retry and plays nothing.
  // Returns whether it took over, in which case the caller does not play.
  const recordedErrorTakesOverPlay = useCallback((audio: HTMLAudioElement) => {
    if (!audio.error || retryStateRef.current.phase !== 'idle') return false;
    userInitiatedRef.current = true;
    playIntentRef.current = true;
    handleError();
    if (!isRetrying(retryStateRef.current)) {
      playIntentRef.current = false;
      if (pendingSeekRef.current) pendingSeekRef.current.autoPlay = false;
      syncPlayRequest();
    }
    return true;
  }, [handleError, pendingSeekRef, playIntentRef, syncPlayRequest, userInitiatedRef]);

  // Handle `canplay` events mid-retry:
  //   - "reloading": our scheduled retry's audio.load() finished successfully
  //     (load() cleared the element's error).
  //   - "scheduled": only if the element's error has cleared on its own. While
  //     it is still set the connection is still down, and a `canplay` is just
  //     a seek into data that was already buffered; counting that as recovery
  //     would cancel the pending retry and restart the backoff at attempt 1
  //     when the stream stalls at the end of the buffer.
  const handleCanPlayAfterError = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const phase = retryStateRef.current;
    if (phase.phase !== 'scheduled' && phase.phase !== 'reloading') return;
    if (phase.phase === 'scheduled' && audio.error) return;

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

    if (audio.currentTime !== phase.savedPosition) {
      audio.currentTime = phase.savedPosition;
      setCurrentTime(phase.savedPosition);
    }
    if (phase.wasPlaying) {
      safePlay(audio, 'resume after reconnect', logDebugEvent);
    }

    dispatchRetry({ type: 'RECOVERED' });
    setIsBuffering(false);
  }, [audioRef, dispatchRetry, logDebugEvent, setCurrentTime, setIsBuffering]);

  /** `canplay` and `playing`: the element can play, so a shown error is over. */
  const handleCanPlay = useCallback(() => {
    const audio = audioRef.current;
    if (audio && !audio.error) setHasMediaError(false);
    handleCanPlayAfterError();
  }, [audioRef, handleCanPlayAfterError]);

  /** `loadedmetadata`: the format plays, so a later source error is transient. */
  const handleLoadedMetadata = useCallback(() => {
    metadataLoadedRef.current = true;
    setHasMediaError(false);
  }, []);

  /** A new source starts a new chain; nothing from the old one carries over. */
  const resetForSource = useCallback(() => {
    dispatchRetry({ type: 'RESET' });
    metadataLoadedRef.current = false;
  }, [dispatchRetry]);

  const clearMediaError = useCallback(() => setHasMediaError(false), []);

  /** The listener's Retry: reload the element and queue `time`, without playing. */
  const reloadFrom = useCallback(
    (time: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      resetForSource();
      pendingSeekRef.current = { time, autoPlay: false };
      setHasMediaError(false);
      setIsBuffering(true);
      audio.load();
      syncPlayRequest();
    },
    [audioRef, pendingSeekRef, resetForSource, setIsBuffering, syncPlayRequest],
  );

  // Where playback is, for relative seeks and for controls outside the player.
  // A retry's reload empties the element, which then reports position 0 until
  // the recovery seek; until then the retry state holds where the listener was.
  const relativeSeekBase = useCallback((audio: HTMLAudioElement) => {
    // Without metadata the element reports 0 wherever the listener is: a
    // queued seek (saved position, ?seek=, external seek, transport switch) is the
    // position.
    if (audio.readyState < 1 && pendingSeekRef.current) {
      return pendingSeekRef.current.time;
    }
    // Until a reconnect recovers, its restore target is the position. The
    // reload resets the element to 0, and metadata can return before the
    // recovery seek, so readyState alone does not tell.
    // After giving up, the element was reset by the last reload as well.
    const retry = retryStateRef.current;
    return retry.phase === 'idle' ? audio.currentTime : retry.savedPosition;
  }, [pendingSeekRef]);

  return {
    /** Read-only in handlers; the reducer state committed to React is `isReconnecting`/`hasError`. */
    retryStateRef,
    isReconnecting,
    hasError: retryState.phase === 'exhausted' || (hasMediaError && !isReconnecting),
    dispatchRetry,
    handleError,
    handleCanPlay,
    handleLoadedMetadata,
    recordedErrorTakesOverPlay,
    resetForSource,
    clearMediaError,
    reloadFrom,
    isPlayRequested,
    syncPlayRequest,
    relativeSeekBase,
  };
}
