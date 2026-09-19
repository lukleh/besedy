import type { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/db';
import {
  getPublishedAccessibleRecordingHashes,
  getPublishedVisibleEventIds,
  isPublishedVisibleEvent,
} from '@/lib/catalog-events/visibility';
import { requiresReleasedEventVisibilityScope } from '@/lib/policy/event';
import { requiresReadyRecordingScope } from '@/lib/policy/recording';
import type { CatalogGrant } from "@/lib/policy/catalog-permissions";

const EMPTY_EVENT_ID_SENTINEL = -1;

const readableEventInclude = {
  location: { select: { id: true, name: true } },
  recordings: {
    select: {
      audioHash: true,
      isPrimary: true,
      sortOrder: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ sortOrder: 'asc' }, { audioHash: 'asc' }],
  },
} satisfies Prisma.CatalogEventInclude;

const readableEventListInclude = {
  location: { select: { id: true, name: true } },
  recordings: {
    select: { audioHash: true, isPrimary: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { audioHash: 'asc' }],
  },
} satisfies Prisma.CatalogEventInclude;

export type ReadableEventIds = number[] | null;

export async function resolveReadableEventIds(
  catalogId: string,
  catalogGrant: CatalogGrant | null,
): Promise<ReadableEventIds> {
  return requiresReleasedEventVisibilityScope(catalogGrant)
    ? getPublishedVisibleEventIds(prisma, catalogId)
    : null;
}

function nonEmptyEventIds(eventIds: number[]): number[] {
  return eventIds.length > 0 ? eventIds : [EMPTY_EVENT_ID_SENTINEL];
}

export function catalogEventVisibilityWhere(
  eventIds: ReadableEventIds,
): Prisma.CatalogEventWhereInput {
  return eventIds === null ? {} : { id: { in: nonEmptyEventIds(eventIds) } };
}

export function buildReadableCatalogEventWhere(
  catalogId: string,
  eventIds: ReadableEventIds,
  filters: Prisma.CatalogEventWhereInput = {},
): Prisma.CatalogEventWhereInput {
  return {
    ...filters,
    workflowGroupId: catalogId,
    ...catalogEventVisibilityWhere(eventIds),
  };
}

export async function listReadableCatalogEvents(
  catalogId: string,
  eventIds: ReadableEventIds,
  filters: Prisma.CatalogEventWhereInput,
  options: {
    orderBy: Prisma.CatalogEventOrderByWithRelationInput[];
    skip?: number;
    take?: number;
  },
) {
  return prisma.catalogEvent.findMany({
    where: buildReadableCatalogEventWhere(catalogId, eventIds, filters),
    orderBy: options.orderBy,
    ...(options.skip === undefined ? {} : { skip: options.skip }),
    ...(options.take === undefined ? {} : { take: options.take }),
    include: readableEventListInclude,
  });
}

/** The tuple the unique identity index groups sessions by, minus the index. */
export interface SessionDateKey {
  locationId: number;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
}

export function sessionDateKey(event: SessionDateKey): string {
  return [
    event.locationId,
    event.dateYear,
    event.dateMonth ?? '',
    event.dateDay ?? '',
  ].join(':');
}

/**
 * How many events share each location and date.
 *
 * The count runs through the same visibility and filters as the listing that
 * asked for it, because the cue it feeds promises the reader another event
 * they can open. Counting events they cannot see would promise a row that is
 * not there.
 */
export async function countSessionsByDate(
  catalogId: string,
  eventIds: ReadableEventIds,
  filters: Prisma.CatalogEventWhereInput,
  keys: SessionDateKey[],
): Promise<Map<string, number>> {
  const unique = new Map<string, SessionDateKey>();
  for (const key of keys) {
    unique.set(sessionDateKey(key), {
      locationId: key.locationId,
      dateYear: key.dateYear,
      dateMonth: key.dateMonth,
      dateDay: key.dateDay,
    });
  }
  if (unique.size === 0) return new Map();

  const rows = await prisma.catalogEvent.groupBy({
    by: ['locationId', 'dateYear', 'dateMonth', 'dateDay'],
    where: {
      AND: [
        buildReadableCatalogEventWhere(catalogId, eventIds, filters),
        { OR: [...unique.values()] },
      ],
    },
    _count: { _all: true },
  });

  return new Map(rows.map((row) => [sessionDateKey(row), row._count._all]));
}

export function catalogEventRecordingVisibilityWhere(
  eventIds: ReadableEventIds,
): Prisma.CatalogEventRecordingWhereInput {
  return eventIds === null
    ? {}
    : { eventId: { in: nonEmptyEventIds(eventIds) } };
}

export async function resolveReadableRecordingHashes(
  catalogId: string,
  catalogGrant: CatalogGrant | null,
  audioHashes: string[],
): Promise<Set<string>> {
  if (audioHashes.length === 0) return new Set();
  if (requiresReadyRecordingScope(catalogGrant)) {
    return getPublishedAccessibleRecordingHashes(prisma, catalogId, audioHashes);
  }
  const rows = await prisma.catalogEntry.findMany({
    where: { workflowGroupId: catalogId, audioHash: { in: audioHashes } },
    select: { audioHash: true },
  });
  return new Set(rows.map((row) => row.audioHash));
}

export async function loadReadableCatalogEvent(
  catalogId: string,
  eventId: number,
  catalogGrant: CatalogGrant | null,
) {
  if (
    requiresReleasedEventVisibilityScope(catalogGrant) &&
    !(await isPublishedVisibleEvent(prisma, catalogId, eventId))
  ) {
    return null;
  }

  const event = await prisma.catalogEvent.findFirst({
    where: { id: eventId, workflowGroupId: catalogId },
    include: readableEventInclude,
  });
  if (!event) return null;

  const hashes = event.recordings.map((recording) => recording.audioHash);
  const visibleHashes = await resolveReadableRecordingHashes(
    catalogId,
    catalogGrant,
    hashes,
  );
  const recordings = event.recordings.filter((recording) =>
    visibleHashes.has(recording.audioHash),
  );

  if (requiresReadyRecordingScope(catalogGrant) && recordings.length === 0) {
    return null;
  }

  return {
    event,
    recordings,
  };
}
