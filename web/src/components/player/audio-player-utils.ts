const RECORDING_HASH_RE =
  /\/api\/catalogs\/[^/]+\/recordings\/([a-f0-9]{64})\/audio/i;

export const MAX_RETRY_ATTEMPTS = 10;
export const INITIAL_RETRY_DELAY_MS = 1000;
export const MAX_RETRY_DELAY_MS = 30000;

export function extractRecordingHash(audioUrl: string): string | null {
  const match = audioUrl.match(RECORDING_HASH_RE);
  return match?.[1] ?? null;
}

type SafePlayLogger = (
  type: "error",
  message: string,
  details?: string
) => void;

/**
 * Invoke `audio.play()` and normalize the common failure modes:
 *   - `AbortError` — user paused before the pending promise resolved. Silent.
 *   - `NotAllowedError` — browser autoplay policy blocked the call. Silent:
 *     it's expected browser behavior (e.g. programmatic resume after the tab
 *     was backgrounded, or a Space keypress before the first real user
 *     gesture), not an app bug.
 *   - Everything else is logged to the console AND — if a debug sink is
 *     provided — emitted as a debug event so true failures are visible in
 *     the player's debug panel instead of silently vanishing.
 *
 * Always use this over calling `audio.play()` directly so that failures
 * can't hide under a bare `.catch(() => {})`.
 */
export function safePlay(
  audio: HTMLAudioElement,
  context: string,
  logDebugEvent?: SafePlayLogger
): Promise<void> {
  return audio.play().catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error.name === "AbortError" || error.name === "NotAllowedError") return;
    const details = `${error.name}: ${error.message || "none"}`;
    console.error(`[AudioPlayer] play() failed (${context}):`, details);
    logDebugEvent?.("error", `play failed: ${context}`, details);
  });
}

export function formatAudioTime(time: number): string {
  if (!isFinite(time)) return "--:--:--";
  const hours = Math.floor(time / 3600);
  const minutes = Math.floor((time % 3600) / 60);
  const seconds = Math.floor(time % 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function getNetworkStateLabel(state: number): string {
  switch (state) {
    case 0:
      return "EMPTY";
    case 1:
      return "IDLE";
    case 2:
      return "LOADING";
    case 3:
      return "NO_SOURCE";
    default:
      return `UNKNOWN(${state})`;
  }
}

export function getReadyStateLabel(state: number): string {
  switch (state) {
    case 0:
      return "HAVE_NOTHING";
    case 1:
      return "HAVE_METADATA";
    case 2:
      return "HAVE_CURRENT_DATA";
    case 3:
      return "HAVE_FUTURE_DATA";
    case 4:
      return "HAVE_ENOUGH_DATA";
    default:
      return `UNKNOWN(${state})`;
  }
}
