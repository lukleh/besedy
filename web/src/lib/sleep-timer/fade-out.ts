/** How long the sleep timer takes to fade playback out. */
export const SLEEP_FADE_MS = 5_000;
const FADE_STEP_MS = 100;

/**
 * How a fade ended: it paused playback, the track ended during it, or a pause
 * from elsewhere or the caller's cancel stopped it.
 */
export type FadeOutcome = "paused" | "ended" | "interrupted";

/**
 * Lowers the element's volume to silence over `durationMs`, pauses it, and
 * puts the volume back so the next play is audible. A pause from elsewhere —
 * the listener, or the track ending — stops the fade and restores the volume.
 * Where the page cannot change the volume (iOS Safari), it pauses at once.
 *
 * Returns a cancel function, which restores the volume without pausing.
 */
export function fadeOutAndPause(
  audio: HTMLAudioElement,
  {
    durationMs = SLEEP_FADE_MS,
    onFinish,
  }: { durationMs?: number; onFinish?: (outcome: FadeOutcome) => void } = {},
): () => void {
  let done = false;
  if (audio.paused) return () => {};

  const startVolume = audio.volume;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;

  const finish = (outcome: FadeOutcome) => {
    if (done) return;
    done = true;
    if (timer !== null) clearInterval(timer);
    audio.removeEventListener("pause", handlePause);
    audio.volume = startVolume;
    onFinish?.(outcome);
  };

  const pauseNow = () => {
    // Ours, so not reported as a pause from elsewhere.
    audio.removeEventListener("pause", handlePause);
    audio.pause();
    finish("paused");
  };

  function handlePause() {
    finish(audio.ended ? "ended" : "interrupted");
  }

  const step = () => {
    const progress = (Date.now() - startedAt) / durationMs;
    if (progress >= 1) {
      pauseNow();
      return;
    }
    const target = startVolume * (1 - progress);
    audio.volume = target;
    // iOS keeps the volume at 1 whatever the page sets.
    if (Math.abs(audio.volume - target) > 0.01) pauseNow();
  };

  if (startVolume === 0) {
    pauseNow();
    return () => {};
  }

  audio.addEventListener("pause", handlePause);
  timer = setInterval(step, FADE_STEP_MS);
  return () => finish("interrupted");
}
