export interface PlaybackProgressSummary {
  positionSec: number;
  durationSec: number | null;
  percent: number;
  completed: boolean;
}

/**
 * A saved position this close to the end counts as finished even without a
 * media `ended` event. Browser-only positions are floored to whole seconds, so
 * the tolerance must exceed one second.
 */
export const PLAYBACK_END_TOLERANCE_SEC = 1.5;

export function isAtPlaybackEnd(
  positionSec: number,
  durationSec: number | null | undefined,
): boolean {
  return (
    durationSec !== null &&
    durationSec !== undefined &&
    durationSec > 0 &&
    positionSec > 0 &&
    positionSec >= durationSec - PLAYBACK_END_TOLERANCE_SEC
  );
}

interface PlaybackProgressRow {
  positionSec: number;
  durationSec: number | null;
  completedAt: Date | string | null;
}

export function summarizePlaybackProgress(
  row: PlaybackProgressRow | null | undefined,
  fallbackDurationSec?: number | null,
): PlaybackProgressSummary | null {
  if (!row) return null;

  const positionSec = Math.max(0, row.positionSec);
  const durationSec =
    row.durationSec && row.durationSec > 0
      ? row.durationSec
      : fallbackDurationSec && fallbackDurationSec > 0
        ? fallbackDurationSec
        : null;
  const completed = row.completedAt !== null;
  const percent = completed
    ? 100
    : positionSec <= 0
      ? 0
      : durationSec
        ? Math.min(99, Math.max(1, Math.round((positionSec / durationSec) * 100)))
        : 0;

  return { positionSec, durationSec, percent, completed };
}

export function selectEventPlaybackProgress(
  summaries: Array<PlaybackProgressSummary | null>,
): PlaybackProgressSummary | null {
  const available = summaries.filter(
    (summary): summary is PlaybackProgressSummary => summary !== null,
  );
  if (available.length === 0) return null;
  return available.reduce((best, current) =>
    current.percent > best.percent ? current : best,
  );
}
