import type { AccessLevel, Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/db';
import {
  catalogEventVisibilityWhere,
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
import {
  executeCatalogLexicalSearch,
  executeCatalogSearch,
  type CatalogSearchResult,
} from '@/app/api/catalogs/[id]/search/search-service';
import {
  RagServiceError,
  type LexicalMatchMode,
  type SearchMetadataFilters,
} from '@/app/api/catalogs/[id]/search/search-route-helpers';
import { getMcpResourceUrl } from '@/lib/mcp/config';

export type McpEventOrder = 'asc' | 'desc';

const MCP_VISIBILITY_ACCESS_LEVEL = 'LISTENER' as const satisfies AccessLevel;

export interface McpEventListInput {
  cursor?: string;
  limit: number;
  order: McpEventOrder;
  released?: boolean;
  query?: string;
  date?: {
    year: number;
    month?: number;
    day?: number;
  };
  locationId?: number;
}

export interface McpLookupListInput {
  cursor?: string;
  limit: number;
  query?: string;
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
  | 'invalid_cursor'
  | 'not_found'
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

interface McpEventCursor {
  version: 1;
  catalogId: string;
  order: McpEventOrder;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
  sessionIndex: number;
  eventId: number;
}

type McpLookupKind = 'location' | 'recorder';

interface McpLookupCursor {
  version: 1;
  catalogId: string;
  kind: McpLookupKind;
  query: string | null;
  id: number;
  name: string;
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function encodeMcpEventCursor(
  catalogId: string,
  order: McpEventOrder,
  event: {
    id: number;
    dateYear: number;
    dateMonth: number | null;
    dateDay: number | null;
    sessionIndex: number;
  },
): string {
  const cursor: McpEventCursor = {
    version: 1,
    catalogId,
    order,
    dateYear: event.dateYear,
    dateMonth: event.dateMonth,
    dateDay: event.dateDay,
    sessionIndex: event.sessionIndex,
    eventId: event.id,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function encodeMcpLookupCursor(
  catalogId: string,
  kind: McpLookupKind,
  query: string | undefined,
  item: { id: number; name: string },
): string {
  const cursor: McpLookupCursor = {
    version: 1,
    catalogId,
    kind,
    query: query ?? null,
    id: item.id,
    name: item.name,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeMcpLookupCursor(
  encoded: string,
  catalogId: string,
  kind: McpLookupKind,
  query: string | undefined,
): McpLookupCursor {
  try {
    const value = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<McpLookupCursor>;
    if (
      value.version !== 1 ||
      value.catalogId !== catalogId ||
      value.kind !== kind ||
      value.query !== (query ?? null) ||
      !isIntegerInRange(value.id, 1, Number.MAX_SAFE_INTEGER) ||
      typeof value.name !== 'string' ||
      value.name.length === 0
    ) {
      throw new Error('Invalid lookup cursor payload');
    }
    return value as McpLookupCursor;
  } catch {
    throw new McpReadError(
      'invalid_cursor',
      `Invalid ${kind} cursor for the selected catalog or query`,
    );
  }
}

function decodeMcpEventCursor(
  encoded: string,
  catalogId: string,
  order: McpEventOrder,
): McpEventCursor {
  try {
    const value = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<McpEventCursor>;
    const validMonth =
      value.dateMonth === null || isIntegerInRange(value.dateMonth, 1, 12);
    const validDay =
      value.dateDay === null || isIntegerInRange(value.dateDay, 1, 31);
    if (
      value.version !== 1 ||
      value.catalogId !== catalogId ||
      value.order !== order ||
      !isIntegerInRange(value.dateYear, 1900, 2100) ||
      !validMonth ||
      !validDay ||
      !isIntegerInRange(value.sessionIndex, 1, Number.MAX_SAFE_INTEGER) ||
      !isIntegerInRange(value.eventId, 1, Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error('Invalid event cursor payload');
    }
    return value as McpEventCursor;
  } catch {
    throw new McpReadError(
      'invalid_cursor',
      'Invalid event cursor for the selected catalog or order',
    );
  }
}

function eventDateOrderBy(
  order: McpEventOrder,
): Prisma.CatalogEventOrderByWithRelationInput[] {
  return [
    { dateYear: order },
    { dateMonth: { sort: order, nulls: 'last' } },
    { dateDay: { sort: order, nulls: 'last' } },
    { sessionIndex: order },
    { id: order },
  ];
}

function numericCursorComparison(value: number, order: McpEventOrder) {
  return order === 'asc' ? { gt: value } : { lt: value };
}

function nullableDateCursorComparison(
  field: 'dateMonth' | 'dateDay',
  value: number | null,
  order: McpEventOrder,
): Prisma.CatalogEventWhereInput | null {
  if (value === null) return null;
  return {
    OR: [{ [field]: numericCursorComparison(value, order) }, { [field]: null }],
  };
}

function eventAfterCursorWhere(
  cursor: McpEventCursor,
): Prisma.CatalogEventWhereInput {
  const monthComparison = nullableDateCursorComparison(
    'dateMonth',
    cursor.dateMonth,
    cursor.order,
  );
  const dayComparison = nullableDateCursorComparison(
    'dateDay',
    cursor.dateDay,
    cursor.order,
  );
  const alternatives: Prisma.CatalogEventWhereInput[] = [
    { dateYear: numericCursorComparison(cursor.dateYear, cursor.order) },
  ];
  if (monthComparison) {
    alternatives.push({
      AND: [{ dateYear: cursor.dateYear }, monthComparison],
    });
  }
  if (dayComparison) {
    alternatives.push({
      AND: [
        { dateYear: cursor.dateYear },
        { dateMonth: cursor.dateMonth },
        dayComparison,
      ],
    });
  }
  alternatives.push(
    {
      AND: [
        { dateYear: cursor.dateYear },
        { dateMonth: cursor.dateMonth },
        { dateDay: cursor.dateDay },
        {
          sessionIndex: numericCursorComparison(
            cursor.sessionIndex,
            cursor.order,
          ),
        },
      ],
    },
    {
      AND: [
        { dateYear: cursor.dateYear },
        { dateMonth: cursor.dateMonth },
        { dateDay: cursor.dateDay },
        { sessionIndex: cursor.sessionIndex },
        { id: numericCursorComparison(cursor.eventId, cursor.order) },
      ],
    },
  );
  return { OR: alternatives };
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
  endSec?: number,
): string {
  const url = new URL(buildRecordingWebUrl(catalogId, audioHash));
  url.searchParams.set('seek', String(startSec));
  if (endSec !== undefined && endSec > startSec) {
    url.searchParams.set('end', String(endSec));
  }
  return url.toString();
}

function incrementCount(counts: Map<number, number>, id: number | null): void {
  if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
}

function paginateLookupItems<T extends { id: number; name: string }>(
  catalogId: string,
  kind: McpLookupKind,
  input: McpLookupListInput,
  items: T[],
) {
  const normalizedQuery = input.query?.toLocaleLowerCase();
  const filtered = items
    .filter(
      (item) =>
        normalizedQuery === undefined ||
        item.name.toLocaleLowerCase().includes(normalizedQuery),
    )
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name, undefined, {
          sensitivity: 'base',
        }) || left.id - right.id,
    );
  const cursor = input.cursor
    ? decodeMcpLookupCursor(input.cursor, catalogId, kind, input.query)
    : null;
  const startIndex = cursor
    ? filtered.findIndex(
        (item) => item.id === cursor.id && item.name === cursor.name,
      ) + 1
    : 0;
  if (cursor && startIndex === 0) {
    throw new McpReadError(
      'invalid_cursor',
      `Invalid ${kind} cursor for the selected catalog or query`,
    );
  }
  const page = filtered.slice(startIndex, startIndex + input.limit);
  const hasMore = startIndex + page.length < filtered.length;
  return {
    items: page,
    nextCursor:
      hasMore && page.length > 0
        ? encodeMcpLookupCursor(catalogId, kind, input.query, page.at(-1)!)
        : null,
  };
}

export async function listMcpLocations(
  catalogId: string,
  input: McpLookupListInput,
) {
  const [recordingRows, visibleEventIds] = await Promise.all([
    prisma.audioMetadata.findMany({
      where: { workflowGroupId: catalogId, locationId: { not: null } },
      select: { audioHash: true, locationId: true },
    }),
    resolveReadableEventIds(catalogId, MCP_VISIBILITY_ACCESS_LEVEL),
  ]);
  const [visibleHashes, eventRows] = await Promise.all([
    resolveReadableRecordingHashes(
      catalogId,
      MCP_VISIBILITY_ACCESS_LEVEL,
      recordingRows.map((row) => row.audioHash),
    ),
    prisma.catalogEvent.findMany({
      where: {
        workflowGroupId: catalogId,
        ...catalogEventVisibilityWhere(visibleEventIds),
      },
      select: { locationId: true },
    }),
  ]);
  const recordingCounts = new Map<number, number>();
  const eventCounts = new Map<number, number>();
  for (const row of recordingRows) {
    if (visibleHashes.has(row.audioHash)) {
      incrementCount(recordingCounts, row.locationId);
    }
  }
  for (const row of eventRows) incrementCount(eventCounts, row.locationId);
  const ids = [...new Set([...recordingCounts.keys(), ...eventCounts.keys()])];
  const locations =
    ids.length === 0
      ? []
      : await prisma.location.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        });
  const page = paginateLookupItems(
    catalogId,
    'location',
    input,
    locations.map((location) => ({
      ...location,
      eventCount: eventCounts.get(location.id) ?? 0,
      recordingCount: recordingCounts.get(location.id) ?? 0,
    })),
  );
  return {
    catalogId,
    locations: page.items,
    nextCursor: page.nextCursor,
  };
}

export async function listMcpRecorders(
  catalogId: string,
  input: McpLookupListInput,
) {
  const recordingRows = await prisma.audioMetadata.findMany({
    where: { workflowGroupId: catalogId, recorderId: { not: null } },
    select: { audioHash: true, recorderId: true },
  });
  const visibleHashes = await resolveReadableRecordingHashes(
    catalogId,
    MCP_VISIBILITY_ACCESS_LEVEL,
    recordingRows.map((row) => row.audioHash),
  );
  const recordingCounts = new Map<number, number>();
  for (const row of recordingRows) {
    if (visibleHashes.has(row.audioHash)) {
      incrementCount(recordingCounts, row.recorderId);
    }
  }
  const ids = [...recordingCounts.keys()];
  const recorders =
    ids.length === 0
      ? []
      : await prisma.recorder.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        });
  const page = paginateLookupItems(
    catalogId,
    'recorder',
    input,
    recorders.map((recorder) => ({
      ...recorder,
      recordingCount: recordingCounts.get(recorder.id) ?? 0,
    })),
  );
  return {
    catalogId,
    recorders: page.items,
    nextCursor: page.nextCursor,
  };
}

export async function listMcpEvents(
  catalogId: string,
  input: McpEventListInput,
) {
  const cursor = input.cursor
    ? decodeMcpEventCursor(input.cursor, catalogId, input.order)
    : null;
  const literalQuery = input.query
    ? escapePrismaContains(input.query)
    : undefined;
  const visibleEventIds = await resolveReadableEventIds(
    catalogId,
    MCP_VISIBILITY_ACCESS_LEVEL,
  );
  const filters: Prisma.CatalogEventWhereInput = {
    ...(cursor ? { AND: [eventAfterCursorWhere(cursor)] } : {}),
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
      orderBy: eventDateOrderBy(input.order),
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
    MCP_VISIBILITY_ACCESS_LEVEL,
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
    nextCursor:
      hasMore && page.length > 0
        ? encodeMcpEventCursor(catalogId, input.order, page.at(-1)!)
        : null,
  };
}

export async function getMcpEvent(
  catalogId: string,
  eventId: number,
  input: McpEventRecordingPageInput,
) {
  const readable = await loadReadableCatalogEvent(
    catalogId,
    eventId,
    MCP_VISIBILITY_ACCESS_LEVEL,
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
  catalogId: string,
  audioHash: string,
  input: McpRecordingEventPageInput,
) {
  const visibleHashes = await resolveReadableRecordingHashes(
    catalogId,
    MCP_VISIBILITY_ACCESS_LEVEL,
    [audioHash],
  );
  if (!visibleHashes.has(audioHash)) {
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
    MCP_VISIBILITY_ACCESS_LEVEL,
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
  catalogId: string,
  audioHash: string,
  input: McpTranscriptInput,
) {
  const visibleHashes = await resolveReadableRecordingHashes(
    catalogId,
    MCP_VISIBILITY_ACCESS_LEVEL,
    [audioHash],
  );
  if (!visibleHashes.has(audioHash)) {
    throw new McpReadError('not_found', 'Recording not found');
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
      webUrl: buildRecordingSeekWebUrl(
        catalogId,
        audioHash,
        segment.start,
        segment.end,
      ),
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
          ...(input.startSec === undefined ? {} : { startSec: input.startSec }),
          ...(input.endSec === undefined ? {} : { endSec: input.endSec }),
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
      accessLevel: MCP_VISIBILITY_ACCESS_LEVEL,
      failOnMissingBundle: true,
    });
  } catch (error) {
    throwMcpSearchError(error);
  }
  const results = await serializeMcpSearchResults(
    catalogId,
    execution.results,
    input.contextChunks,
  );

  return {
    catalogId,
    query: execution.query,
    retrieval: {
      mode: 'semantic' as const,
      exhaustive: false,
      requestedLimit: input.limit,
      returnedCount: results.length,
      maxPerRecording: input.maxPerRecording,
    },
    results,
  };
}

export async function findMcpTranscriptMentions(
  catalogId: string,
  input: {
    query: string;
    matchMode: LexicalMatchMode;
    limit: number;
    contextChunks: number;
    maxPerRecording: number;
    filters?: SearchMetadataFilters;
  },
) {
  let execution: Awaited<ReturnType<typeof executeCatalogLexicalSearch>>;
  try {
    execution = await executeCatalogLexicalSearch({
      catalogId,
      query: input.query,
      matchMode: input.matchMode,
      limit: input.limit,
      includeNeighbors: input.contextChunks > 0,
      neighborCount: input.contextChunks,
      maxPerAudio: input.maxPerRecording,
      metadataFilters: input.filters ?? null,
      accessLevel: MCP_VISIBILITY_ACCESS_LEVEL,
      failOnMissingBundle: true,
    });
  } catch (error) {
    throwMcpSearchError(error);
  }
  const results = await serializeMcpSearchResults(
    catalogId,
    execution.results,
    input.contextChunks,
  );

  return {
    catalogId,
    query: execution.query,
    retrieval: {
      mode: 'lexical' as const,
      matchMode: input.matchMode,
      corpusCoverage: 'complete' as const,
      totalMatches: execution.totalMatches,
      requestedLimit: input.limit,
      returnedCount: results.length,
      maxPerRecording: input.maxPerRecording,
    },
    results,
  };
}

function throwMcpSearchError(error: unknown): never {
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

async function serializeMcpSearchResults(
  catalogId: string,
  searchResults: CatalogSearchResult[],
  contextChunks: number,
) {
  const audioHashes = [
    ...new Set(searchResults.map((result) => result.audioHash)),
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

  return searchResults.map((result) => {
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
          result.endSec,
        ),
      },
      context:
        contextChunks > 0
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
              contextChunks > 0 ? result.contextStartSec : result.startSec,
            endSec: contextChunks > 0 ? result.contextEndSec : result.endSec,
          }
        : null,
    };
  });
}
