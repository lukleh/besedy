'use client';

import { useTranslations } from 'next-intl';
import { CheckCircle2, PlayCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PlaybackProgressSummary } from '@/lib/playback-progress';

interface EventPlaybackProgressProps {
  playback: PlaybackProgressSummary | null;
  className?: string;
  layout?: 'stacked' | 'inline';
  showLabel?: boolean;
}

export function EventPlaybackProgress({
  playback,
  className,
  layout = 'stacked',
  showLabel = false,
}: EventPlaybackProgressProps) {
  const t = useTranslations('events.progress');
  if (!playback || playback.percent <= 0) return null;

  if (playback.completed) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary',
          className,
        )}
        aria-label={t('listened')}
      >
        <CheckCircle2 className="h-5 w-5" />
        {showLabel ? <span>{t('listened')}</span> : null}
      </span>
    );
  }

  if (layout === 'inline') {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-end gap-1.5 text-xs tabular-nums text-muted-foreground',
          className,
        )}
        aria-label={t('percentListened', { percent: playback.percent })}
      >
        <PlayCircle className="h-3.5 w-3.5" />
        <span>{playback.percent}%</span>
        <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full rounded-full bg-primary"
            style={{ width: `${playback.percent}%` }}
          />
        </span>
      </span>
    );
  }

  return (
    <span
      className={cn('flex w-16 shrink-0 flex-col gap-1', className)}
      aria-label={t('percentListened', { percent: playback.percent })}
    >
      <span className="inline-flex items-center justify-end gap-1 text-xs tabular-nums text-muted-foreground">
        <PlayCircle className="h-3.5 w-3.5" />
        {playback.percent}%
      </span>
      <span className="h-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${playback.percent}%` }}
        />
      </span>
    </span>
  );
}
