import type { AccessLevel, Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/db';
import {
  getPublishedAccessibleRecordingHashes,
  getPublishedVisibleEventIds,
  isPublishedVisibleEvent,
} from '@/lib/catalog-events/visibility';
import { requiresReleasedEventVisibilityScope } from '@/lib/policy/event';
import { requiresReadyRecordingScope } from '@/lib/policy/recording';

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
  catalogGrant: AccessLevel | null,
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

export function catalogEventRecordingVisibilityWhere(
  eventIds: ReadableEventIds,
): Prisma.CatalogEventRecordingWhereInput {
  return eventIds === null
    ? {}
    : { eventId: { in: nonEmptyEventIds(eventIds) } };
}

export async function resolveReadableRecordingHashes(
  catalogId: string,
  catalogGrant: AccessLevel | null,
  audioHashes: string[],
): Promise<Set<string>> {
  return requiresReadyRecordingScope(catalogGrant)
    ? getPublishedAccessibleRecordingHashes(prisma, catalogId, audioHashes)
    : new Set(audioHashes);
}

export async function loadReadableCatalogEvent(
  catalogId: string,
  eventId: number,
  catalogGrant: AccessLevel | null,
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
