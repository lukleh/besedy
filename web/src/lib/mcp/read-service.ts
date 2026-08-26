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
import {
  RagServiceError,
  type SearchMetadataFilters,
} from '@/app/api/catalogs/[id]/search/search-route-helpers';
import { getMcpResourceUrl } from '@/lib/mcp/config';

const eventSummaryInclude = {
  location: { select: { id: true, name: true } },
  recordings: {
    select: { audioHash: true, isPrimary: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { audioHash: 'asc' }],
  },
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
  segmentOffset: number;
  segmentLimit: number;
  maxTextChars: number;
}

export interface McpEventRecordingPageInput {
  offset: number;
  limit: number;
}

export interface McpRecordingEventPageInput {
  offset: number;
  limit: number;
}

export class McpReadError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'permission_denied'
      | 'transcript_not_found'
      | 'invalid_window'
      | 'search_unavailable',
    message: string,
  ) {
    super(message);
  }
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

function serializeRecordingSummary(
  hash: string,
  rows: Awaited<ReturnType<typeof loadRecordingRows>>,
) {
  const recording = serializeRecording(hash, rows);
  return {
    audioHash: recording.audioHash,
    title: recording.title,
    artist: recording.artist,
    durationHms: recording.durationHms,
    ready: recording.ready,
    published: recording.published,
  };
}

function buildEventWebUrl(catalogId: string, eventId: number): string {
  return new URL(
    `/catalog/${encodeURIComponent(catalogId)}/event/${eventId}`,
    getMcpResourceUrl(),
  ).toString();
}

function buildRecordingWebUrl(catalogId: string, audioHash: string): string {
  return new URL(
    `/catalog/${encodeURIComponent(catalogId)}/recording/${encodeURIComponent(audioHash)}`,
    getMcpResourceUrl(),
  ).toString();
}

function buildRecordingSeekWebUrl(
  catalogId: string,
  audioHash: string,
  startSec: number,
): string {
  const url = new URL(buildRecordingWebUrl(catalogId, audioHash));
  url.searchParams.set('seek', String(startSec));
  return url.toString();
}

export async function listMcpEvents(
  catalogId: string,
  catalogGrant: AccessLevel | null,
  input: McpEventListInput,
) {
  const visibleEventIds = requiresReleasedEventVisibilityScope(catalogGrant)
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
            { description: { contains: input.query, mode: 'insensitive' } },
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
  const pageHashes = [
    ...new Set(
      page.flatMap((event) =>
        event.recordings.map((recording) => recording.audioHash),
      ),
    ),
  ];
  const visibleHashes = requiresReadyRecordingScope(catalogGrant)
    ? await getPublishedAccessibleRecordingHashes(prisma, catalogId, pageHashes)
    : new Set(pageHashes);
  const primaryHashes = page
    .map(
      (event) =>
        event.recordings.find((recording) => recording.isPrimary)?.audioHash ??
        event.recordings[0]?.audioHash,
    )
    .filter(
      (hash): hash is string => hash !== undefined && visibleHashes.has(hash),
    );
  const rows = await loadRecordingRows(catalogId, primaryHashes);

  return {
    catalogId,
    events: page.map((event) => {
      const primaryHash =
        event.recordings.find((recording) => recording.isPrimary)?.audioHash ??
        event.recordings[0]?.audioHash ??
        null;
      const visiblePrimaryHash =
        primaryHash !== null && visibleHashes.has(primaryHash)
          ? primaryHash
          : null;
      return {
        id: event.id,
        webUrl: buildEventWebUrl(catalogId, event.id),
        title: event.title,
        description: event.description,
        date: serializeDate(event.dateYear, event.dateMonth, event.dateDay),
        sessionIndex: event.sessionIndex,
        location: event.location,
        released: event.released,
        recordingCount: event.recordings.filter((recording) =>
          visibleHashes.has(recording.audioHash),
        ).length,
        primaryRecording:
          visiblePrimaryHash === null
            ? null
            : serializeRecordingSummary(visiblePrimaryHash, rows),
        updatedAt: event.updatedAt.toISOString(),
      };
    }),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getMcpEvent(
  catalogId: string,
  eventId: number,
  catalogGrant: AccessLevel | null,
  input: McpEventRecordingPageInput,
) {
  if (
    requiresReleasedEventVisibilityScope(catalogGrant) &&
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
  const visibleHashes = requiresReadyRecordingScope(catalogGrant)
    ? await getPublishedAccessibleRecordingHashes(prisma, catalogId, hashes)
    : new Set(hashes);
  const visibleRecordings = event.recordings.filter((recording) =>
    visibleHashes.has(recording.audioHash),
  );
  if (
    requiresReadyRecordingScope(catalogGrant) &&
    visibleRecordings.length === 0
  ) {
    throw new McpReadError('not_found', 'Event not found');
  }
  const recordingPage = visibleRecordings.slice(
    input.offset,
    input.offset + input.limit,
  );
  const rows = await loadRecordingRows(
    catalogId,
    recordingPage.map((recording) => recording.audioHash),
  );
  const nextOffset =
    input.offset + recordingPage.length < visibleRecordings.length
      ? input.offset + recordingPage.length
      : null;

  return {
    catalogId,
    event: {
      id: event.id,
      webUrl: buildEventWebUrl(catalogId, event.id),
      title: event.title,
      description: event.description,
      date: serializeDate(event.dateYear, event.dateMonth, event.dateDay),
      sessionIndex: event.sessionIndex,
      location: event.location,
      released: event.released,
      recordings: {
        items: recordingPage.map((recording) => ({
          ...serializeRecordingSummary(recording.audioHash, rows),
          webUrl: buildRecordingWebUrl(catalogId, recording.audioHash),
          isPrimary: recording.isPrimary,
          sortOrder: recording.sortOrder,
        })),
        totalVisible: visibleRecordings.length,
        nextOffset,
      },
      createdAt: event.createdAt.toISOString(),
      updatedAt: event.updatedAt.toISOString(),
    },
  };
}

export async function getMcpRecording(
  userId: string,
  catalogId: string,
  audioHash: string,
  input: McpRecordingEventPageInput,
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

  const visibleEventIds = requiresReleasedEventVisibilityScope(
    capability.catalogGrant,
  )
    ? await getPublishedVisibleEventIds(prisma, catalogId)
    : null;
  const eventWhere: Prisma.CatalogEventRecordingWhereInput = {
    workflowGroupId: catalogId,
    audioHash,
    ...(visibleEventIds === null
      ? {}
      : {
          eventId: {
            in: visibleEventIds.length > 0 ? visibleEventIds : [-1],
          },
        }),
  };
  const [eventLinks, totalVisible] = await Promise.all([
    prisma.catalogEventRecording.findMany({
      where: eventWhere,
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
      skip: input.offset,
      take: input.limit,
    }),
    prisma.catalogEventRecording.count({ where: eventWhere }),
  ]);
  const nextOffset =
    input.offset + eventLinks.length < totalVisible
      ? input.offset + eventLinks.length
      : null;

  return {
    catalogId,
    recording: {
      ...recording,
      webUrl: buildRecordingWebUrl(catalogId, audioHash),
    },
    events: {
      items: eventLinks.map(({ event, isPrimary }) => ({
        id: event.id,
        webUrl: buildEventWebUrl(catalogId, event.id),
        title: event.title,
        released: event.released,
        date: serializeDate(event.dateYear, event.dateMonth, event.dateDay),
        isPrimary,
      })),
      totalVisible,
      nextOffset,
    },
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

  const matchingSegments = transcript.segments
    .map((segment, segmentIndex) => ({ segment, segmentIndex }))
    .filter(
      ({ segment }) =>
        (input.startSec === undefined || segment.end > input.startSec) &&
        (input.endSec === undefined || segment.start < input.endSec),
    );
  const candidates = matchingSegments.slice(
    input.segmentOffset,
    input.segmentOffset + input.segmentLimit,
  );
  const segments = [];
  let returnedTextChars = 0;
  for (const { segment, segmentIndex } of candidates) {
    const textChars = segment.text.length;
    if (
      segments.length > 0 &&
      returnedTextChars + textChars > input.maxTextChars
    ) {
      break;
    }
    segments.push({
      segmentIndex,
      id: segment.id ?? null,
      text: segment.text,
      startSec: segment.start,
      endSec: segment.end,
      speaker: segment.speaker ?? null,
    });
    returnedTextChars += textChars;
  }
  const nextOffset =
    input.segmentOffset + segments.length < matchingSegments.length
      ? input.segmentOffset + segments.length
      : null;

  return {
    catalogId,
    audioHash,
    recordingWebUrl: buildRecordingWebUrl(catalogId, audioHash),
    backend,
    availableBackends: available.backends,
    language: transcript.language ?? null,
    durationSec: transcript.duration ?? null,
    timeWindow: {
      startSec: input.startSec ?? null,
      endSec: input.endSec ?? null,
    },
    segments: {
      items: segments,
      offset: input.segmentOffset,
      limit: input.segmentLimit,
      maxTextChars: input.maxTextChars,
      returnedTextChars,
      totalMatching: matchingSegments.length,
      nextOffset,
    },
  };
}

export async function searchMcpTranscripts(
  catalogId: string,
  catalogGrant: AccessLevel | null,
  input: {
    query: string;
    limit: number;
    contextChunks: number;
    maxPerRecording?: number;
    filters?: SearchMetadataFilters;
  },
) {
  let execution: Awaited<ReturnType<typeof executeCatalogSearch>>;
  try {
    execution = await executeCatalogSearch({
      catalogId,
      query: input.query,
      limit: input.limit,
      includeNeighbors: input.contextChunks > 0,
      neighborCount: input.contextChunks,
      maxPerAudio: input.maxPerRecording ?? null,
      metadataFilters: input.filters ?? null,
      accessLevel: catalogGrant,
      failOnMissingBundle: true,
    });
  } catch (error) {
    if (error instanceof RagServiceError) {
      throw new McpReadError(
        'search_unavailable',
        'Transcript search is temporarily unavailable',
      );
    }
    throw error;
  }
  const recordingRows = await loadRecordingRows(catalogId, [
    ...new Set(execution.results.map((result) => result.audioHash)),
  ]);

  return {
    catalogId,
    query: execution.query,
    results: execution.results.map((result) => ({
      rank: result.rank,
      score: result.score,
      recording: {
        ...serializeRecordingSummary(result.audioHash, recordingRows),
        webUrl: buildRecordingWebUrl(catalogId, result.audioHash),
      },
      match: {
        chunkId: result.chunkId,
        startSec: result.startSec,
        endSec: result.endSec,
        text: result.text,
        webUrl: buildRecordingSeekWebUrl(
          catalogId,
          result.audioHash,
          result.startSec,
        ),
      },
      context:
        input.contextChunks > 0
          ? {
              startSec: result.contextStartSec,
              endSec: result.contextEndSec,
              text: result.contextText,
            }
          : null,
      metadata: result.metadata,
      citation: result.citation,
    })),
  };
}
