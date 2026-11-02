/**
 * The playback position of one player, kept outside React state.
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
export interface PlaybackClock {
  get(): number;
  set(time: number): void;
  subscribe(listener: () => void): () => void;
}

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function createPlaybackClock(initialTime = 0): PlaybackClock {
  let time = initialTime;
  let notifiedTime = initialTime;
  const listeners = new Set<() => void>();

  const notify = () => {
    notifiedTime = time;
    for (const listener of [...listeners]) listener();
  };
  const handleVisibilityChange = () => {
    if (!pageHidden() && time !== notifiedTime) notify();
  };

  return {
    get: () => time,
    set(nextTime) {
      if (nextTime === time) return;
      time = nextTime;
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
