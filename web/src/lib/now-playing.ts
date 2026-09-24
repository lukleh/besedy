/**
 * The recording the listener is playing, kept so an installed app that the
 * OS killed in the background can pick playback up again.
 *
 * The record is written while a recording plays and marked stopped when the
 * listener pauses, closes the page or navigates away. After a kill none of
 * those run, so a record that still says `playing` when the recording page
 * loads again means the app did not stop on purpose. Getting back to the page
 * is the last-route cookie's job (lib/pwa/last-route.ts); this only decides
 * whether to press play.
 */

const NOW_PLAYING_KEY = "besedy-now-playing";

/**
 * A record whose last heartbeat is older than this is not evidence of an
 * interrupted session; the listener has long moved on.
 */
export const NOW_PLAYING_RESUME_WINDOW_MS = 60 * 60 * 1000;

export interface NowPlaying {
  catalogId: string;
  hash: string;
  positionSec: number;
  /** True while the listener wants playback; false after a pause or a deliberate close. */
  playing: boolean;
  updatedAt: number;
}

export type NowPlayingResumeReason =
  | "resumed"
  | "none"
  | "other-recording"
  | "stopped"
  | "stale";

export interface NowPlayingResume {
  /** The interrupted record when playback should resume, otherwise null. */
  record: NowPlaying | null;
  reason: NowPlayingResumeReason;
}

function isNowPlaying(value: unknown): value is NowPlaying {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.catalogId === "string" &&
    typeof record.hash === "string" &&
    typeof record.positionSec === "number" &&
    Number.isFinite(record.positionSec) &&
    typeof record.playing === "boolean" &&
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt)
  );
}

export function readNowPlaying(): NowPlaying | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(NOW_PLAYING_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isNowPlaying(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeNowPlaying(record: NowPlaying) {
  try {
    localStorage.setItem(NOW_PLAYING_KEY, JSON.stringify(record));
  } catch {
    // Resuming is best-effort; storage may be full or blocked.
  }
}

/** Records that this recording is playing at the given position. */
export function saveNowPlaying(
  record: Omit<NowPlaying, "updatedAt">,
  now = Date.now(),
) {
  if (typeof window === "undefined") return;
  writeNowPlaying({
    ...record,
    positionSec: Math.max(0, record.positionSec),
    updatedAt: now,
  });
}

/**
 * Marks the recording's record as deliberately stopped. A record for another
 * recording is left alone.
 */
export function stopNowPlaying(hash: string, now = Date.now()) {
  const current = readNowPlaying();
  if (!current || current.hash !== hash || !current.playing) return;
  writeNowPlaying({ ...current, playing: false, updatedAt: now });
}

export function clearNowPlaying(hash: string) {
  const current = readNowPlaying();
  if (!current || current.hash !== hash) return;
  try {
    localStorage.removeItem(NOW_PLAYING_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/**
 * Decides whether a recording page that just loaded should resume playback,
 * and consumes the record so a later load of the same page does not resume
 * again. Only a fresh record for this recording that still says `playing`
 * qualifies.
 */
export function takeResumableNowPlaying(
  catalogId: string,
  hash: string,
  now = Date.now(),
): NowPlayingResume {
  const current = readNowPlaying();
  if (!current) return { record: null, reason: "none" };
  if (current.catalogId !== catalogId || current.hash !== hash) {
    return { record: null, reason: "other-recording" };
  }
  if (!current.playing) return { record: null, reason: "stopped" };
  if (now - current.updatedAt > NOW_PLAYING_RESUME_WINDOW_MS) {
    return { record: null, reason: "stale" };
  }
  writeNowPlaying({ ...current, playing: false, updatedAt: now });
  return { record: current, reason: "resumed" };
}
