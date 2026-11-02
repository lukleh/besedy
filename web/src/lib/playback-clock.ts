/**
 * Values that follow playback, such as a player's position or its buffer
 * reading, kept outside React state.
 *
 * The media element reports its time about four times a second. Holding it in
 * page state re-rendered the whole recording page on every report; with a
 * long word-level transcript that was tens of milliseconds of work each time
 * on a phone, for a handful of changed elements. Components subscribe instead
 * and re-render only when what they show changes (see `usePlaybackTime`).
 *
 * While the page is hidden (screen off, app in the background) subscribers
 * are not told about new times, since nothing is drawn; they catch up once
 * when it is visible again. `get()` always returns the latest time, so
 * position saving and other non-visual work never falls behind.
 */
export interface HeldValue<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

export type PlaybackClock = HeldValue<number>;

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * A value that changes with playback, held back from subscribers while the
 * page is hidden (see above). `equal` decides whether a new value is a change
 * worth telling subscribers about.
 */
export function createHeldValue<T>(
  initialValue: T,
  equal: (a: T, b: T) => boolean = (a, b) => a === b,
): HeldValue<T> {
  let value = initialValue;
  let notifiedValue = initialValue;
  const listeners = new Set<() => void>();

  const notify = () => {
    notifiedValue = value;
    for (const listener of [...listeners]) listener();
  };
  const handleVisibilityChange = () => {
    if (!pageHidden() && !equal(value, notifiedValue)) notify();
  };

  return {
    get: () => value,
    set(nextValue) {
      if (equal(nextValue, value)) return;
      value = nextValue;
      if (!pageHidden()) notify();
    },
    subscribe(listener) {
      if (listeners.size === 0 && typeof document !== "undefined") {
        document.addEventListener("visibilitychange", handleVisibilityChange);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", handleVisibilityChange);
        }
      };
    },
  };
}

export function createPlaybackClock(initialTime = 0): PlaybackClock {
  return createHeldValue(initialTime);
}
