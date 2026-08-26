import type { AccessLevel, Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/db';
import { getRecordingCapability } from '@/lib/access/capabilities';
import {
  getPublishedAccessibleRecordingHashes,
  getPublishedVisibleEventIds,
  isPublishedVisibleEvent,
} from '@/lib/catalog-events/visibility';
import { requiresReleasedEventVisibilityScope } from '@/lib/policy/event';
import { requiresReadyRecordingScope } from '@/lib/policy/recording';
import { resolveTranscriptsPath } from '@/lib/paths';
import {
  getAvailableTranscripts,
  loadTranscript,
  type TranscriptBackend,
} from '@/lib/transcript';
import { listTranscriptBackendPriorities } from '@/lib/transcript-priority';
import { executeCatalogSearch } from '@/app/api/catalogs/[id]/search/search-service';

const eventSummaryInclude = {
  location: { select: { id: true, name: true } },
  recordings: {
    select: { audioHash: true, isPrimary: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { audioHash: 'asc' }],
  },
  _count: { select: { recordings: true } },
} satisfies Prisma.CatalogEventInclude;

const recordingMetadataSelect = {
  audioHash: true,
  title: true,
  artist: true,
  verified: true,
  dateYear: true,
  dateMonth: true,
  dateDay: true,
  notes: true,
  tags: true,
  album: { select: { id: true, name: true } },
  recorder: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
} satisfies Prisma.AudioMetadataSelect;

export interface McpEventListInput {
  cursor?: number;
  limit: number;
  released?: boolean;
  query?: string;
}

export interface McpTranscriptInput {
  backend?: TranscriptBackend;
  startSec?: number;
  endSec?: number;
  offset: number;
  limit: number;
}

export class McpReadError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'permission_denied'
      | 'transcript_not_found'
      | 'invalid_window',
    message: string,
  ) {
    super(message);
  }
}

function accessLevelForPolicy(
  accessLevel: AccessLevel | 'NONE',
): AccessLevel | null {
  return accessLevel === 'NONE' ? null : accessLevel;
}

function serializeDate(year: number, month: number | null, day: number | null) {
  return { year, month, day };
}

async function loadRecordingRows(catalogId: string, hashes: string[]) {
  if (hashes.length === 0) {
    return { catalogByHash: new Map(), metadataByHash: new Map() };
  }

  const [catalogRows, metadataRows] = await Promise.all([
    prisma.catalogEntry.findMany({
      where: { workflowGroupId: catalogId, audioHash: { in: hashes } },
      select: {
        audioHash: true,
        durationHms: true,
        sourceTitle: true,
        sourceArtist: true,
        sourceAlbum: true,
        sourceDate: true,
        isActionable: true,
        isPublished: true,
      },
    }),
    prisma.audioMetadata.findMany({
      where: { workflowGroupId: catalogId, audioHash: { in: hashes } },
      select: recordingMetadataSelect,
    }),
  ]);

  return {
    catalogByHash: new Map(catalogRows.map((row) => [row.audioHash, row])),
    metadataByHash: new Map(metadataRows.map((row) => [row.audioHash, row])),
  };
}

function serializeRecording(
  hash: string,
  rows: Awaited<ReturnType<typeof loadRecordingRows>>,
) {
  const catalog = rows.catalogByHash.get(hash);
  const metadata = rows.metadataByHash.get(hash);

  return {
    audioHash: hash,
    title: metadata?.title ?? catalog?.sourceTitle ?? hash,
    artist: metadata?.artist ?? catalog?.sourceArtist ?? null,
    album:
      metadata?.album ??
      (catalog?.sourceAlbum ? { id: null, name: catalog.sourceAlbum } : null),
    durationHms: catalog?.durationHms ?? null,
    sourceDate: catalog?.sourceDate ?? null,
    date: {
      year: metadata?.dateYear ?? null,
      month: metadata?.dateMonth ?? null,
      day: metadata?.dateDay ?? null,
    },
    location: metadata?.location ?? null,
    recorder: metadata?.recorder ?? null,
    verified: metadata?.verified ?? false,
    notes: metadata?.notes ?? null,
    tags: metadata?.tags ?? [],
    ready: catalog?.isActionable ?? false,
    published: catalog?.isPublished ?? false,
  };
}

export async function listMcpEvents(
  catalogId: string,
  accessLevel: AccessLevel | 'NONE',
  input: McpEventListInput,
) {
  const policyAccessLevel = accessLevelForPolicy(accessLevel);
  const visibleEventIds = requiresReleasedEventVisibilityScope(
    policyAccessLevel,
  )
    ? await getPublishedVisibleEventIds(prisma, catalogId)
    : null;
  const where: Prisma.CatalogEventWhereInput = {
    workflowGroupId: catalogId,
    ...(visibleEventIds === null
      ? {}
      : { id: { in: visibleEventIds.length > 0 ? visibleEventIds : [-1] } }),
    ...(input.cursor ? { AND: [{ id: { lt: input.cursor } }] } : {}),
    ...(input.released === undefined ? {} : { released: input.released }),
    ...(input.query
      ? {
          OR: [
            { title: { contains: input.query, mode: 'insensitive' } },
            {
              location: {
                name: { contains: input.query, mode: 'insensitive' },
              },
            },
          ],
        }
      : {}),
  };
  const events = await prisma.catalogEvent.findMany({
    where,
    orderBy: { id: 'desc' },
    take: input.limit + 1,
    include: eventSummaryInclude,
  });
  const hasMore = events.length > input.limit;
  const page = hasMore ? events.slice(0, input.limit) : events;
  const primaryHashes = page
    .map(
      (event) =>
        event.recordings.find((recording) => recording.isPrimary)?.audioHash ??
        event.recordings[0]?.audioHash,
    )
    .filter((hash): hash is string => Boolean(hash));
  const rows = await loadRecordingRows(catalogId, primaryHashes);

  return {
    catalogId,
    events: page.map((event) => {
      const primaryHash =
        event.recordings.find((recording) => recording.isPrimary)?.audioHash ??
        event.recordings[0]?.audioHash ??
        null;
      return {
        id: event.id,
        title: event.title,
        description: event.description,
        date: serializeDate(event.dateYear, event.dateMonth, event.dateDay),
        sessionIndex: event.sessionIndex,
        location: event.location,
        released: event.released,
        recordingCount: event._count.recordings,
        primaryRecording:
          primaryHash === null ? null : serializeRecording(primaryHash, rows),
        updatedAt: event.updatedAt.toISOString(),
      };
    }),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getMcpEvent(
  catalogId: string,
  eventId: number,
  accessLevel: AccessLevel | 'NONE',
) {
  const policyAccessLevel = accessLevelForPolicy(accessLevel);
  if (
    requiresReleasedEventVisibilityScope(policyAccessLevel) &&
    !(await isPublishedVisibleEvent(prisma, catalogId, eventId))
  ) {
    throw new McpReadError('not_found', 'Event not found');
  }

  const event = await prisma.catalogEvent.findFirst({
    where: { id: eventId, workflowGroupId: catalogId },
    include: eventSummaryInclude,
  });
  if (!event) throw new McpReadError('not_found', 'Event not found');

  const hashes = event.recordings.map((recording) => recording.audioHash);
  const visibleHashes = requiresReadyRecordingScope(policyAccessLevel)
    ? await getPublishedAccessibleRecordingHashes(prisma, catalogId, hashes)
    : new Set(hashes);
  const orderedHashes = event.recordings
    .filter((recording) => visibleHashes.has(recording.audioHash))
    .map((recording) => recording.audioHash);
  if (
    requiresReadyRecordingScope(policyAccessLevel) &&
    orderedHashes.length === 0
  ) {
    throw new McpReadError('not_found', 'Event not found');
  }
  const rows = await loadRecordingRows(catalogId, orderedHashes);

  return {
    catalogId,
    event: {
      id: event.id,
      title: event.title,
      description: event.description,
      date: serializeDate(event.dateYear, event.dateMonth, event.dateDay),
      sessionIndex: event.sessionIndex,
      location: event.location,
      released: event.released,
      recordings: event.recordings
        .filter((recording) => visibleHashes.has(recording.audioHash))
        .map((recording) => ({
          ...serializeRecording(recording.audioHash, rows),
          isPrimary: recording.isPrimary,
          sortOrder: recording.sortOrder,
        })),
      createdAt: event.createdAt.toISOString(),
      updatedAt: event.updatedAt.toISOString(),
    },
  };
}

export async function getMcpRecording(
  userId: string,
  catalogId: string,
  audioHash: string,
) {
  const capability = await getRecordingCapability(catalogId, audioHash, userId);
  if (!capability.canAccessRecording) {
    throw new McpReadError('not_found', 'Recording not found');
  }
  const rows = await loadRecordingRows(catalogId, [audioHash]);
  if (!rows.catalogByHash.has(audioHash)) {
    throw new McpReadError('not_found', 'Recording not found');
  }
  const recording = serializeRecording(audioHash, rows);

  const eventLinks = await prisma.catalogEventRecording.findMany({
    where: { workflowGroupId: catalogId, audioHash },
    select: {
      isPrimary: true,
      event: {
        select: {
          id: true,
          title: true,
          released: true,
          dateYear: true,
          dateMonth: true,
          dateDay: true,
        },
      },
    },
    orderBy: { eventId: 'desc' },
  });
  const visibleEventIds = requiresReleasedEventVisibilityScope(
    capability.catalogGrant,
  )
    ? new Set(await getPublishedVisibleEventIds(prisma, catalogId))
    : null;

  return {
    catalogId,
    recording,
    events: eventLinks
      .filter(({ event }) => visibleEventIds?.has(event.id) ?? true)
      .map(({ event, isPrimary }) => ({
        id: event.id,
        title: event.title,
        released: event.released,
        date: serializeDate(event.dateYear, event.dateMonth, event.dateDay),
        isPrimary,
      })),
  };
}

export async function getMcpTranscript(
  userId: string,
  catalogId: string,
  audioHash: string,
  input: McpTranscriptInput,
) {
  const capability = await getRecordingCapability(catalogId, audioHash, userId);
  if (!capability.canAccessRecording) {
    throw new McpReadError('not_found', 'Recording not found');
  }
  if (!capability.canViewRecordingTranscripts) {
    throw new McpReadError(
      'permission_denied',
      'Transcript access requires VIEWER role or higher',
    );
  }
  if (
    input.startSec !== undefined &&
    input.endSec !== undefined &&
    input.endSec <= input.startSec
  ) {
    throw new McpReadError(
      'invalid_window',
      'endSec must be greater than startSec',
    );
  }

  const transcriptsPath = resolveTranscriptsPath(catalogId);
  const priorities = await listTranscriptBackendPriorities();
  const available = await getAvailableTranscripts(transcriptsPath, audioHash, {
    priorities,
  });
  const backend = input.backend ?? available.backends[0];
  if (!backend || !available.backends.includes(backend)) {
    throw new McpReadError('transcript_not_found', 'Transcript not found');
  }
  const transcript = await loadTranscript(transcriptsPath, audioHash, backend);
  if (!transcript) {
    throw new McpReadError('transcript_not_found', 'Transcript not found');
  }

  const matchingSegments = transcript.segments.filter(
    (segment) =>
      (input.startSec === undefined || segment.end >= input.startSec) &&
      (input.endSec === undefined || segment.start <= input.endSec),
  );
  const segments = matchingSegments
    .slice(input.offset, input.offset + input.limit)
    .map(({ id, text, start, end, speaker }) => ({
      id: id ?? null,
      text,
      startSec: start,
      endSec: end,
      speaker: speaker ?? null,
    }));
  const nextOffset =
    input.offset + segments.length < matchingSegments.length
      ? input.offset + segments.length
      : null;

  return {
    catalogId,
    audioHash,
    backend,
    availableBackends: available.backends,
    language: transcript.language ?? null,
    durationSec: transcript.duration ?? null,
    window: {
      startSec: input.startSec ?? null,
      endSec: input.endSec ?? null,
      offset: input.offset,
      limit: input.limit,
    },
    segments,
    totalMatchingSegments: matchingSegments.length,
    nextOffset,
  };
}

export async function searchMcpTranscripts(
  catalogId: string,
  accessLevel: AccessLevel | 'NONE',
  input: {
    query: string;
    limit: number;
    includeNeighbors: boolean;
  },
) {
  const execution = await executeCatalogSearch({
    catalogId,
    query: input.query,
    limit: input.limit,
    includeNeighbors: input.includeNeighbors,
    neighborCount: input.includeNeighbors ? 1 : 0,
    accessLevel: accessLevelForPolicy(accessLevel),
  });

  return {
    catalogId,
    query: execution.query,
    results: execution.results.map((result) => ({
      rank: result.rank,
      audioHash: result.audioHash,
      chunkId: result.chunkId,
      score: result.score,
      startSec: result.startSec,
      endSec: result.endSec,
      text: result.text,
      contextText: result.contextText,
      contextStartSec: result.contextStartSec,
      contextEndSec: result.contextEndSec,
      neighbors: result.neighbors,
      metadata: result.metadata,
      citation: result.citation,
    })),
  };
}
