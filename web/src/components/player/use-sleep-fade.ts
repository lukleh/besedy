import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { fadeOutAndPause } from '@/lib/sleep-timer/fade-out';
import type { DebugEventType } from './audio-player-types';

/**
 * The sleep timer's fade-out. `sleepFadeOutAndPause` is what the timer calls
 * when it fires; `cancelSleepFade` ends a fade in progress and is called on
 * every volume change from the listener and on a source switch.
 */
export function useSleepFade({
  audioRef,
  playIntentRef,
  logDebugEvent,
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  playIntentRef: RefObject<boolean>;
  logDebugEvent: (type: DebugEventType, message: string, details?: string) => void;
}) {
  const cancelSleepFadeRef = useRef<(() => void) | null>(null);

  const cancelSleepFade = useCallback(() => {
    cancelSleepFadeRef.current?.();
  }, []);

  const sleepFadeOutAndPause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || audio.paused) return () => {};
    cancelSleepFade();
    const cancel = fadeOutAndPause(audio, {
      onFinish: (outcome) => {
        if (cancelSleepFadeRef.current === cancel) {
          cancelSleepFadeRef.current = null;
        }
        if (outcome !== 'paused') return;
        // A deliberate stop, not an interrupted play.
        playIntentRef.current = false;
        logDebugEvent('pause', 'Sleep timer paused playback');
      },
    });
    cancelSleepFadeRef.current = cancel;
    return cancel;
  }, [audioRef, cancelSleepFade, logDebugEvent, playIntentRef]);

  // A fade must not outlive the player.
  useEffect(() => () => cancelSleepFadeRef.current?.(), []);

  return { cancelSleepFade, sleepFadeOutAndPause };
}
