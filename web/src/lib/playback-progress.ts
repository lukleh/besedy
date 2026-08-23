export interface PlaybackProgressSummary {
  positionSec: number;
  durationSec: number | null;
  percent: number;
  completed: boolean;
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
