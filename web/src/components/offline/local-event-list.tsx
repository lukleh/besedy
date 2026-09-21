'use client';

/**
 * A catalog's downloaded events, rendered through the normal event list
 * component from the download registry. Shown when the catalog page cannot
 * be loaded from the server.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Loader2 } from 'lucide-react';
import { EventListResults } from '@/components/catalog/event-list-results';
import type { CatalogEventRow } from '@/components/catalog/event-list-types';
import { useDownloadManager } from '@/hooks/use-downloads';
import type { DownloadRecord } from '@/lib/offline/downloads-db';
import { summarizePlaybackProgress } from '@/lib/playback-progress';
import {
  getSavedPlaybackPosition,
  isPlaybackCompleted,
} from '@/lib/playback-position';

interface LocalEventListProps {
  catalogId: string;
}

function durationSeconds(durationHms: string | null): number | null {
  if (!durationHms) return null;
  const parts = durationHms.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? seconds : null;
}

function eventIdOf(record: DownloadRecord): number | null {
  if (record.eventKey) {
    const eventId = Number(record.eventKey.slice(record.catalogId.length + 1));
    if (Number.isSafeInteger(eventId) && eventId >= 0) return eventId;
  }
  return record.event?.id ?? null;
}

export function localEventRows(
  records: readonly DownloadRecord[],
  catalogId: string,
): CatalogEventRow[] {
  const rows = new Map<number, CatalogEventRow>();
  const sorted = [...records].sort((a, b) => b.createdAt - a.createdAt);
  for (const record of sorted) {
    if (record.catalogId !== catalogId || record.status !== 'complete') continue;
    const event = record.event;
    const eventId = eventIdOf(record);
    if (!event || eventId === null || rows.has(eventId)) continue;
    const completed = isPlaybackCompleted(record.hash);
    const positionSec = getSavedPlaybackPosition(record.hash) ?? 0;
    const playback =
      completed || positionSec > 0
        ? summarizePlaybackProgress(
            {
              positionSec,
              durationSec: null,
              completedAt: completed ? new Date(0) : null,
            },
            durationSeconds(record.recording?.durationHms ?? null),
          )
        : null;
    rows.set(eventId, {
      id: eventId,
      title: event.title,
      location: event.locationName ? { id: 0, name: event.locationName } : null,
      dateYear: event.dateYear,
      dateMonth: event.dateMonth,
      dateDay: event.dateDay,
      sessionIndex: event.sessionIndex,
      sessionOrdinal: event.sessionOrdinal ?? 1,
      sessionCount: event.sessionCount ?? 1,
      released: true,
      recordingCount: 1,
      sourceCount: 0,
      artworkStatus: event.publishedArtwork ? 'published' : 'none',
      primaryAudioHash: record.hash,
      primaryTitle: record.recording?.title ?? null,
      playback,
    });
  }
  return Array.from(rows.values()).sort((a, b) => {
    const dateA = a.dateYear * 10_000 + (a.dateMonth ?? 0) * 100 + (a.dateDay ?? 0);
    const dateB = b.dateYear * 10_000 + (b.dateMonth ?? 0) * 100 + (b.dateDay ?? 0);
    return dateB - dateA || b.sessionIndex - a.sessionIndex;
  });
}

const noop = () => {};

export function LocalEventList({ catalogId }: LocalEventListProps) {
  const t = useTranslations('downloads');
  const { records, hydrated } = useDownloadManager();
  const events = useMemo(() => localEventRows(records, catalogId), [records, catalogId]);
  const catalogLabel =
    records.find((record) => record.catalogId === catalogId && record.catalogLabel)
      ?.catalogLabel ?? null;

  if (!hydrated) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="@container/catalog w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-6 sm:pt-6 space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Download className="h-6 w-6" aria-hidden="true" />
          {t('downloadedEvents')}
        </h1>
        {catalogLabel && (
          <p className="text-sm text-muted-foreground">{catalogLabel}</p>
        )}
      </header>
      <div data-testid="local-event-list">
        <EventListResults
          catalogId={catalogId}
          dateYearFilter="all"
          events={events}
          hasActiveFilters={false}
          locationFilter="all"
          locationOptions={[]}
          onDateYearFilterChange={noop}
          onLocationFilterChange={noop}
          onReleasedFilterChange={noop}
          onSort={noop}
          releasedFilter="all"
          showAllColumns={false}
          showFilters={false}
          showReleaseState={false}
          sortDir="desc"
          sortKey="date"
          yearOptions={[]}
        />
      </div>
    </div>
  );
}
