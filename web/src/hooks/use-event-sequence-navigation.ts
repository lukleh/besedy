'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { fetchJson } from '@/lib/api/fetch-json';
import { useIsDesktop } from '@/hooks/use-media-query';
import {
  buildEventListParams,
  loadStoredEventListState,
} from '@/components/catalog/event-list-storage';
import type {
  EventListQueryState,
  EventSortKey,
  SortDirection,
  StoredEventListState,
} from '@/components/catalog/event-list-types';

const sequenceResponseSchema = z.object({
  previous: z
    .object({
      id: z.number(),
      dateYear: z.number(),
      dateMonth: z.number().nullable(),
      dateDay: z.number().nullable(),
      location: z.object({ id: z.number(), name: z.string() }).nullable(),
    })
    .nullable(),
  next: z
    .object({
      id: z.number(),
      dateYear: z.number(),
      dateMonth: z.number().nullable(),
      dateDay: z.number().nullable(),
      location: z.object({ id: z.number(), name: z.string() }).nullable(),
    })
    .nullable(),
  position: z.number().nullable(),
  total: z.number(),
});

export type EventSequenceItem = NonNullable<
  z.infer<typeof sequenceResponseSchema>['previous']
>;

const EVENT_SORT_KEYS = new Set<EventSortKey>([
  'date',
  'location',
  'recordingCount',
  'released',
]);

const DEFAULT_SEQUENCE_STATE: EventListQueryState = {
  releasedFilter: 'all',
  locationFilter: 'all',
  dateYearFilter: 'all',
  sortKey: 'date',
  sortDir: 'desc',
};

const SEQUENCE_QUERY_PROFILE = {
  staleTime: 30_000,
  gcTime: 60_000,
  refetchOnMount: true as const,
};
const SERVER_STATE_SNAPSHOT = '__server__';

function loadSequenceState(
  stored: StoredEventListState | null,
  dateOnly: boolean,
  showAllColumns: boolean,
  showReleaseState: boolean,
): EventListQueryState {
  const parsedSortKey = EVENT_SORT_KEYS.has(stored?.sortKey as EventSortKey)
    ? (stored?.sortKey as EventSortKey)
    : 'date';
  const storedSortKey =
    parsedSortKey === 'date' ||
    parsedSortKey === 'location' ||
    (showAllColumns &&
      (parsedSortKey === 'recordingCount' || parsedSortKey === 'released'))
      ? parsedSortKey
      : 'date';
  const storedSortDir: SortDirection =
    stored?.sortDir === 'asc' ? 'asc' : 'desc';
  const sortKey = dateOnly ? 'date' : storedSortKey;
  const sortDir =
    dateOnly && storedSortKey !== 'date' ? 'desc' : storedSortDir;

  return {
    releasedFilter:
      showReleaseState &&
      (stored?.releasedFilter === 'true' || stored?.releasedFilter === 'false')
        ? stored.releasedFilter
        : 'all',
    locationFilter: stored?.locationFilter || 'all',
    dateYearFilter: stored?.dateYearFilter || 'all',
    sortKey,
    sortDir,
  };
}

function sequenceQueryKey(
  catalogId: string,
  eventId: number,
  state: EventListQueryState,
) {
  return [
    'event-sequence',
    catalogId,
    eventId,
    state.releasedFilter,
    state.locationFilter,
    state.dateYearFilter,
    state.sortKey,
    state.sortDir,
  ] as const;
}

function isDefaultSequenceState(state: EventListQueryState) {
  return (
    state.releasedFilter === 'all' &&
    state.locationFilter === 'all' &&
    state.dateYearFilter === 'all' &&
    state.sortKey === 'date' &&
    state.sortDir === 'desc'
  );
}

async function fetchSequence(
  catalogId: string,
  eventId: number,
  state: EventListQueryState,
) {
  const params = buildEventListParams(catalogId, 1, 0, state);
  params.set('sequence', 'true');
  params.set('current', String(eventId));
  return fetchJson<z.infer<typeof sequenceResponseSchema>>(
    `/api/catalog-events?${params.toString()}`,
    { schema: sequenceResponseSchema },
  );
}

export function useEventSequenceNavigation(
  catalogId: string,
  eventId: number,
  options: { showAllColumns: boolean; showReleaseState: boolean },
) {
  const isDesktop = useIsDesktop();
  const subscribeToStorage = useCallback((onStoreChange: () => void) => {
    window.addEventListener('storage', onStoreChange);
    return () => window.removeEventListener('storage', onStoreChange);
  }, []);
  const getStoredStateSnapshot = useCallback(
    () => JSON.stringify(loadStoredEventListState(catalogId)),
    [catalogId],
  );
  const getServerStateSnapshot = useCallback(() => SERVER_STATE_SNAPSHOT, []);
  const storedStateSnapshot = useSyncExternalStore(
    subscribeToStorage,
    getStoredStateSnapshot,
    getServerStateSnapshot,
  );
  const sequenceState = useMemo(() => {
    if (storedStateSnapshot === SERVER_STATE_SNAPSHOT) return null;
    const stored = JSON.parse(storedStateSnapshot) as StoredEventListState | null;
    return loadSequenceState(
      stored,
      !isDesktop,
      options.showAllColumns,
      options.showReleaseState,
    );
  }, [
    isDesktop,
    options.showAllColumns,
    options.showReleaseState,
    storedStateSnapshot,
  ]);
  const primaryState = sequenceState ?? DEFAULT_SEQUENCE_STATE;
  const primaryQuery = useQuery({
    queryKey: sequenceQueryKey(catalogId, eventId, primaryState),
    queryFn: () => fetchSequence(catalogId, eventId, primaryState),
    enabled: sequenceState !== null,
    ...SEQUENCE_QUERY_PROFILE,
  });

  const needsFallback =
    sequenceState !== null &&
    primaryQuery.isSuccess &&
    primaryQuery.data.position === null &&
    !isDefaultSequenceState(primaryState);
  const fallbackQuery = useQuery({
    queryKey: sequenceQueryKey(catalogId, eventId, DEFAULT_SEQUENCE_STATE),
    queryFn: () => fetchSequence(catalogId, eventId, DEFAULT_SEQUENCE_STATE),
    enabled: needsFallback,
    ...SEQUENCE_QUERY_PROFILE,
  });
  const query = needsFallback ? fallbackQuery : primaryQuery;

  return {
    ...query,
    previous: query.data?.previous ?? null,
    next: query.data?.next ?? null,
    position: query.data?.position ?? null,
    total: query.data?.total ?? 0,
  };
}
