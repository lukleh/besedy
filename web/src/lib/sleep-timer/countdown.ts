/**
 * Sleep timer countdown.
 *
 * The countdown only runs while audio plays: pausing, buffering and the gap
 * between radio tracks do not use it up. Elapsed time is measured between
 * calls, so a throttled background tab still counts every second it played;
 * a late tick catches up instead of losing time.
 *
 * It runs out once, on a tick while audio plays, and then switches itself
 * off; only a new `start` sets it again. Reaching zero as playback stops
 * leaves it at zero, so whatever plays next — radio's next track, a network
 * recovery — runs it out on the next tick.
 */

export const SLEEP_TIMER_MINUTES = [15, 30, 45, 60] as const;

export interface SleepCountdown {
  /** Sets the timer to `durationMs`, replacing one that is already set. */
  start(durationMs: number): void;
  cancel(): void;
  /** Whether audio is playing, and so whether the countdown runs. */
  setRunning(running: boolean): void;
  /**
   * Counts the playing time since the last call. Returns true when this call
   * ran the countdown out; the timer is then off.
   */
  tick(): boolean;
  /** Milliseconds left, or null when the timer is off. */
  remainingMs(): number | null;
}

export function createSleepCountdown(
  now: () => number = () => performance.now(),
): SleepCountdown {
  let remaining: number | null = null;
  let running = false;
  // When the counted time was last taken; set only while counting.
  let countedUntil: number | null = null;

  function count() {
    if (remaining === null || countedUntil === null) return;
    const time = now();
    remaining = Math.max(0, remaining - Math.max(0, time - countedUntil));
    countedUntil = time;
  }

  return {
    start(durationMs) {
      remaining = durationMs;
      countedUntil = running ? now() : null;
    },

    cancel() {
      remaining = null;
      countedUntil = null;
    },

    setRunning(nextRunning) {
      if (nextRunning === running) return;
      count();
      running = nextRunning;
      countedUntil = running && remaining !== null ? now() : null;
    },

    tick() {
      if (!running) return false;
      count();
      if (remaining !== 0) return false;
      remaining = null;
      countedUntil = null;
      return true;
    },

    remainingMs() {
      return remaining;
    },
  };
}
