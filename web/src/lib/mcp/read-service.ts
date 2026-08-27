import type { AccessLevel, Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/db';
import { getRecordingCapability } from '@/lib/access/capabilities';
import { TRANSCRIPT_ACCESS_DENIED_MESSAGE } from '@/lib/access/messages';
import {
  catalogEventRecordingVisibilityWhere,
  listReadableCatalogEvents,
  loadReadableCatalogEvent,
  resolveReadableEventIds,
  resolveReadableRecordingHashes,
} from '@/lib/catalog-events/read-service';
import {
  loadCatalogRecordingReadModels,
  type CatalogRecordingReadModel,
} from '@/lib/catalog-recordings/read-service';
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

export interface McpEventListInput {
  cursor?: number;
  limit: number;
  released?: boolean;
  query?: string;
  date?: {
    year: number;
    month?: number;
    day?: number;
  };
  locationId?: number;
}

interface McpTranscriptCommonInput {
  backend?: TranscriptBackend;
  startSec?: number;
  endSec?: number;
}

export type McpTranscriptInput = McpTranscriptCommonInput &
  (
    | { mode: 'full' }
    | {
        mode: 'page';
        segmentOffset: number;
        segmentLimit: number;
        maxTextChars: number;
      }
  );

export interface McpEventRecordingPageInput {
  offset: number;
  limit: number;
}

export interface McpRecordingEventPageInput {
  offset: number;
  limit: number;
}

export type McpReadErrorCode =
  | 'not_found'
  | 'permission_denied'
  | 'transcript_not_found'
  | 'invalid_window'
  | 'search_not_configured'
  | 'search_unavailable';

function isRetryableReadError(code: McpReadErrorCode): boolean {
  return code === 'search_unavailable';
}

export class McpReadError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: McpReadErrorCode,
    message: string,
  ) {
    super(message);
    this.retryable = isRetryableReadError(code);
  }
}

function serializeDate(year: number, month: number | null, day: number | null) {
  return { year, month, day };
}

function escapePrismaContains(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function resolveSearchTranscriptBackend(
  indexedBackend: string,
  availableBackends: TranscriptBackend[],
): TranscriptBackend | null {
  if (availableBackends.includes(indexedBackend)) {
    return indexedBackend;
  }

  const languageAgnosticBackend = indexedBackend.replace(/@lang-[^/@]+$/, '');
  if (availableBackends.includes(languageAgnosticBackend)) {
    return languageAgnosticBackend;
  }

  return availableBackends[0] ?? null;
}

function serializeRecording(recording: CatalogRecordingReadModel) {
  return {
    audioHash: recording.audioHash,
    title: recording.title,
    artist: recording.artist,
    album: recording.album,
    durationHms: recording.durationHms,
    sourceDate: recording.sourceDate,
    date: recording.date,
    location: recording.location,
    recorder: recording.recorder,
    verified: recording.verified,
    notes: recording.notes,
    tags: recording.tags,
    ready: recording.ready,
    published: recording.published,
  };
}

function serializeRecordingSummary(recording: CatalogRecordingReadModel) {
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
  const literalQuery = input.query
    ? escapePrismaContains(input.query)
    : undefined;
  const visibleEventIds = await resolveReadableEventIds(
    catalogId,
    catalogGrant,
  );
  const filters: Prisma.CatalogEventWhereInput = {
    ...(input.cursor ? { AND: [{ id: { lt: input.cursor } }] } : {}),
    ...(input.released === undefined ? {} : { released: input.released }),
    ...(input.date
      ? {
          dateYear: input.date.year,
          ...(input.date.month === undefined
            ? {}
            : { dateMonth: input.date.month }),
          ...(input.date.day === undefined ? {} : { dateDay: input.date.day }),
        }
      : {}),
    ...(input.locationId === undefined ? {} : { locationId: input.locationId }),
    ...(literalQuery
      ? {
          OR: [
            { title: { contains: literalQuery, mode: 'insensitive' } },
            { description: { contains: literalQuery, mode: 'insensitive' } },
            {
              location: {
                name: { contains: literalQuery, mode: 'insensitive' },
              },
            },
          ],
        }
      : {}),
  };
  const events = await listReadableCatalogEvents(
    catalogId,
    visibleEventIds,
    filters,
    {
      orderBy: [{ id: 'desc' }],
      take: input.limit + 1,
    },
  );
  const hasMore = events.length > input.limit;
  const page = hasMore ? events.slice(0, input.limit) : events;
  const pageHashes = [
    ...new Set(
      page.flatMap((event) =>
        event.recordings.map((recording) => recording.audioHash),
      ),
    ),
  ];
  const visibleHashes = await resolveReadableRecordingHashes(
    catalogId,
    catalogGrant,
    pageHashes,
  );
  return {
    catalogId,
    events: page.map((event) => {
      const visibleRecordings = event.recordings.filter((recording) =>
        visibleHashes.has(recording.audioHash),
      );
      const primaryAudioHash =
        visibleRecordings.find((recording) => recording.isPrimary)?.audioHash ??
        visibleRecordings[0]?.audioHash ??
        null;
      return {
        id: event.id,
        webUrl: buildEventWebUrl(catalogId, event.id),
        title: event.title,
        description: event.description,
        date: serializeDate(event.dateYear, event.dateMonth, event.dateDay),
        sessionIndex: event.sessionIndex,
        location: event.location,
        released: event.released,
        recordings: {
          primaryAudioHash,
          audioHashes: visibleRecordings.map(
            (recording) => recording.audioHash,
          ),
        },
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
  const readable = await loadReadableCatalogEvent(
    catalogId,
    eventId,
    catalogGrant,
  );
  if (!readable) throw new McpReadError('not_found', 'Event not found');
  const { event, recordings: visibleRecordings } = readable;
  const recordingPage = visibleRecordings.slice(
    input.offset,
    input.offset + input.limit,
  );
  const recordingByHash = await loadCatalogRecordingReadModels(
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
          ...serializeRecordingSummary(
            recordingByHash.get(recording.audioHash)!,
          ),
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
  const recordingByHash = await loadCatalogRecordingReadModels(catalogId, [
    audioHash,
  ]);
  const recordingModel = recordingByHash.get(audioHash)!;
  if (!recordingModel.catalogEntryExists) {
    throw new McpReadError('not_found', 'Recording not found');
  }
  const recording = serializeRecording(recordingModel);

  const visibleEventIds = await resolveReadableEventIds(
    catalogId,
    capability.catalogGrant,
  );
  const eventWhere: Prisma.CatalogEventRecordingWhereInput = {
    workflowGroupId: catalogId,
    audioHash,
    ...catalogEventRecordingVisibilityWhere(visibleEventIds),
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
      TRANSCRIPT_ACCESS_DENIED_MESSAGE,
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
  const candidates =
    input.mode === 'full'
      ? matchingSegments
      : matchingSegments.slice(
          input.segmentOffset,
          input.segmentOffset + input.segmentLimit,
        );
  const segments = [];
  let returnedTextChars = 0;
  for (const { segment, segmentIndex } of candidates) {
    const textChars = segment.text.length;
    if (
      input.mode === 'page' &&
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
      webUrl: buildRecordingSeekWebUrl(catalogId, audioHash, segment.start),
    });
    returnedTextChars += textChars;
  }
  const nextOffset =
    input.mode === 'page' &&
    input.segmentOffset + segments.length < matchingSegments.length
      ? input.segmentOffset + segments.length
      : null;
  const continuation =
    input.mode === 'full' || nextOffset === null
      ? null
      : {
          catalogId,
          audioHash,
          backend,
          mode: 'page' as const,
          startSec: input.startSec ?? null,
          endSec: input.endSec ?? null,
          segmentOffset: nextOffset,
          segmentLimit: input.segmentLimit,
          maxTextChars: input.maxTextChars,
        };

  return {
    catalogId,
    audioHash,
    recordingWebUrl: buildRecordingWebUrl(catalogId, audioHash),
    seekWebUrl: segments[0]?.webUrl ?? null,
    backend,
    availableBackends: available.backends,
    language: transcript.language ?? null,
    durationSec: transcript.duration ?? null,
    mode: input.mode,
    timeWindow: {
      startSec: input.startSec ?? null,
      endSec: input.endSec ?? null,
    },
    segments: {
      items: segments,
      offset: input.mode === 'page' ? input.segmentOffset : 0,
      limit: input.mode === 'page' ? input.segmentLimit : null,
      maxTextChars: input.mode === 'page' ? input.maxTextChars : null,
      returnedTextChars,
      totalMatching: matchingSegments.length,
      nextOffset,
    },
    continuation,
  };
}

export async function searchMcpTranscripts(
  catalogId: string,
  catalogGrant: AccessLevel | null,
  input: {
    query: string;
    limit: number;
    contextChunks: number;
    maxPerRecording: number;
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
      maxPerAudio: input.maxPerRecording,
      metadataFilters: input.filters ?? null,
      accessLevel: catalogGrant,
      failOnMissingBundle: true,
    });
  } catch (error) {
    if (error instanceof RagServiceError) {
      if (error.status === 404) {
        throw new McpReadError(
          'search_not_configured',
          'Transcript search is not configured for this catalog',
        );
      }
      throw new McpReadError(
        'search_unavailable',
        'Transcript search is temporarily unavailable',
      );
    }
    throw error;
  }
  const audioHashes = [
    ...new Set(execution.results.map((result) => result.audioHash)),
  ];
  const [recordingByHash, priorities] = await Promise.all([
    loadCatalogRecordingReadModels(catalogId, audioHashes),
    listTranscriptBackendPriorities(),
  ]);
  const transcriptsPath = resolveTranscriptsPath(catalogId);
  const availableBackendsByHash = new Map(
    await Promise.all(
      audioHashes.map(async (audioHash) => {
        const available = await getAvailableTranscripts(
          transcriptsPath,
          audioHash,
          { priorities },
        );
        return [audioHash, available.backends] as const;
      }),
    ),
  );

  return {
    catalogId,
    query: execution.query,
    retrieval: {
      mode: 'semantic' as const,
      exhaustive: false,
      requestedLimit: input.limit,
      returnedCount: execution.results.length,
      maxPerRecording: input.maxPerRecording,
    },
    results: execution.results.map((result) => {
      const transcriptBackend = resolveSearchTranscriptBackend(
        result.citation.backendKey,
        availableBackendsByHash.get(result.audioHash) ?? [],
      );
      return {
        rank: result.rank,
        recording: {
          ...serializeRecordingSummary(recordingByHash.get(result.audioHash)!),
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
                beforeText:
                  result.neighbors.before
                    .map((neighbor) => neighbor.text)
                    .join('\n\n') || null,
                afterText:
                  result.neighbors.after
                    .map((neighbor) => neighbor.text)
                    .join('\n\n') || null,
              }
            : null,
        metadata: result.metadata,
        citation: result.citation,
        transcriptRequest: transcriptBackend
          ? {
              catalogId,
              audioHash: result.audioHash,
              backend: transcriptBackend,
              mode: 'page' as const,
              startSec:
                input.contextChunks > 0
                  ? result.contextStartSec
                  : result.startSec,
              endSec:
                input.contextChunks > 0 ? result.contextEndSec : result.endSec,
            }
          : null,
      };
    }),
  };
}
