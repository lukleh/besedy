const PLAYBACK_POSITION_PREFIX = "besedy-playback-";

function getPlaybackPositionKey(hash: string) {
  return `${PLAYBACK_POSITION_PREFIX}${hash}`;
}

export function getSavedPlaybackPosition(hash: string): number | null {
  if (typeof window === "undefined") return null;

  try {
    const saved = localStorage.getItem(getPlaybackPositionKey(hash));
    if (!saved) {
      return null;
    }

    const parsed = Number.parseFloat(saved);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface SavePlaybackPositionOptions {
  clearWhenZero?: boolean;
}

export function savePlaybackPosition(
  hash: string,
  time: number,
  { clearWhenZero = false }: SavePlaybackPositionOptions = {}
) {
  if (typeof window === "undefined") return;

  try {
    if (time > 0) {
      localStorage.setItem(getPlaybackPositionKey(hash), String(Math.floor(time)));
      return;
    }

    if (clearWhenZero) {
      localStorage.removeItem(getPlaybackPositionKey(hash));
    }
  } catch {
    // Ignore localStorage errors (quota exceeded, etc.)
  }
}

export function clearPlaybackPosition(hash: string) {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem(getPlaybackPositionKey(hash));
  } catch {
    // Ignore localStorage errors
  }
}
