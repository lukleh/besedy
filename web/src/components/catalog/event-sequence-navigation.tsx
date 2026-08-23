'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatPartialDate } from '@/lib/date-format';
import {
  useEventSequenceNavigation,
  type EventSequenceItem,
} from '@/hooks/use-event-sequence-navigation';

interface EventSequenceNavigationProps {
  catalogId: string;
  eventId: number;
  showAllColumns: boolean;
  showReleaseState: boolean;
}

export function EventSequenceNavigation({
  catalogId,
  eventId,
  showAllColumns,
  showReleaseState,
}: EventSequenceNavigationProps) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations('events.navigation');
  const { previous, next, position, total, isLoading } =
    useEventSequenceNavigation(catalogId, eventId, {
      showAllColumns,
      showReleaseState,
    });

  const openEvent = (item: EventSequenceItem | null) => {
    if (!item) return;
    router.push(`/catalog/${catalogId}/event/${item.id}`);
  };
  const describe = (item: EventSequenceItem | null) => {
    if (!item) return undefined;
    const date =
      formatPartialDate(item.dateYear, item.dateMonth, item.dateDay, locale) ??
      String(item.dateYear);
    return item.location?.name ? `${date} · ${item.location.name}` : date;
  };

  return (
    <nav
      className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg border bg-muted/20 p-2"
      aria-label={t('ariaLabel')}
      data-testid="event-sequence-navigation"
    >
      <Button
        type="button"
        variant="ghost"
        className="h-auto min-h-10 justify-start px-2"
        disabled={!previous || isLoading}
        onClick={() => openEvent(previous)}
        title={describe(previous)}
      >
        <ChevronLeft className="mr-1 h-4 w-4 shrink-0" />
        <span className="truncate">{t('previous')}</span>
      </Button>
      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {position ? t('position', { position, total }) : '—'}
      </span>
      <Button
        type="button"
        variant="ghost"
        className="h-auto min-h-10 justify-end px-2"
        disabled={!next || isLoading}
        onClick={() => openEvent(next)}
        title={describe(next)}
      >
        <span className="truncate">{t('next')}</span>
        <ChevronRight className="ml-1 h-4 w-4 shrink-0" />
      </Button>
    </nav>
  );
}
