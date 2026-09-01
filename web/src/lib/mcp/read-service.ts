import { Prisma, type AccessLevel } from '@/generated/prisma/client';
import prisma from '@/lib/db';
import {
  catalogEventVisibilityWhere,
  catalogEventRecordingVisibilityWhere,
  listReadableCatalogEvents,
  loadReadableCatalogEvent,
  resolveReadableEventIds,
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
  buildAllowedAudioHashesQuery,
  buildEligibleAudioHashesQuery,
  type LexicalMatchMode,
  type SearchMetadataFilters,
} from '@/app/api/catalogs/[id]/search/search-route-helpers';
import { getMcpResourceUrl } from '@/lib/mcp/config';

export type McpEventOrder = 'asc' | 'desc';

const MCP_VISIBILITY_ACCESS_LEVEL = 'LISTENER' as const satisfies AccessLevel;
const MAX_FULL_TRANSCRIPT_TEXT_CHARS = 200_000;
const TRANSCRIPT_BACKEND_LOOKUP_CONCURRENCY = 8;

export interface McpEventListInput {
  cursor?: string;
  limit: number;
  order: McpEventOrder;
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

export type McpReadErrorCode =
  | 'invalid_cursor'
  | 'not_found'
  | 'transcript_not_found'
  | 'invalid_window'
  | 'response_too_large'
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
  const visibleEventIds = await resolveReadableEventIds(
    catalogId,
    MCP_VISIBILITY_ACCESS_LEVEL,
  );
  const eventRows = await prisma.catalogEvent.findMany({
    where: {
      workflowGroupId: catalogId,
      ...catalogEventVisibilityWhere(visibleEventIds),
    },
    select: { locationId: true },
  });
  const eventCounts = new Map<number, number>();
  for (const row of eventRows) incrementCount(eventCounts, row.locationId);
  const ids = [...eventCounts.keys()];
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
  const eligibleHashesQuery = buildEligibleAudioHashesQuery(
    catalogId,
    MCP_VISIBILITY_ACCESS_LEVEL,
    null,
  );
  const recorders = await prisma.$queryRaw<
    { id: number; name: string; recordingCount: number }[]
  >(Prisma.sql`
    SELECT
      recorder.id,
      recorder.name,
      COUNT(*)::integer AS "recordingCount"
    FROM (${eligibleHashesQuery}) AS eligible
    JOIN audio_metadata metadata
      ON metadata.workflow_group_id = ${catalogId}
     AND metadata.audio_hash = eligible."audioHash"
    JOIN recorders recorder ON recorder.id = metadata.recorder_id
    GROUP BY recorder.id, recorder.name
  `);
  const page = paginateLookupItems(catalogId, 'recorder', input, recorders);
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
  return {
    catalogId,
    events: page.map((event) => ({
      id: event.id,
      webUrl: buildEventWebUrl(catalogId, event.id),
      date: serializeDate(event.dateYear, event.dateMonth, event.dateDay),
      location: event.location,
    })),
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
      recordings: {
        items: recordingPage.map((recording) => ({
          audioHash: recording.audioHash,
          webUrl: buildRecordingWebUrl(catalogId, recording.audioHash),
          isPrimary: recording.isPrimary,
        })),
        totalVisible: visibleRecordings.length,
        nextOffset,
      },
    },
  };
}

export async function getMcpRecording(catalogId: string, audioHash: string) {
  const visibleHashes = await resolveMcpReadableRecordingHashes(catalogId, [
    audioHash,
  ]);
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
  const eventLink = await prisma.catalogEventRecording.findFirst({
    where: eventWhere,
    select: {
      isPrimary: true,
      event: {
        select: {
          id: true,
          dateYear: true,
          dateMonth: true,
          dateDay: true,
          location: { select: { id: true, name: true } },
        },
      },
    },
  });

  return {
    catalogId,
    recording: {
      ...recording,
      webUrl: buildRecordingWebUrl(catalogId, audioHash),
    },
    event: eventLink
      ? {
          id: eventLink.event.id,
          webUrl: buildEventWebUrl(catalogId, eventLink.event.id),
          date: serializeDate(
            eventLink.event.dateYear,
            eventLink.event.dateMonth,
            eventLink.event.dateDay,
          ),
          location: eventLink.event.location,
          isPrimary: eventLink.isPrimary,
        }
      : null,
  };
}

export async function getMcpTranscript(
  catalogId: string,
  audioHash: string,
  input: McpTranscriptInput,
) {
  const visibleHashes = await resolveMcpReadableRecordingHashes(catalogId, [
    audioHash,
  ]);
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
      input.mode === 'full' &&
      returnedTextChars + textChars > MAX_FULL_TRANSCRIPT_TEXT_CHARS
    ) {
      throw new McpReadError(
        'response_too_large',
        'Transcript window is too large for full mode; use page mode or a narrower time window',
      );
    }
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
    backend,
    availableBackends: available.backends,
    language: transcript.language ?? null,
    durationSec: transcript.duration ?? null,
    segments: {
      items: segments,
      totalMatching: matchingSegments.length,
    },
    continuation,
  };
}

async function resolveMcpReadableRecordingHashes(
  catalogId: string,
  audioHashes: string[],
): Promise<Set<string>> {
  const eligibleQuery = buildAllowedAudioHashesQuery(
    catalogId,
    audioHashes,
    MCP_VISIBILITY_ACCESS_LEVEL,
    null,
  );
  if (!eligibleQuery) return new Set();
  const rows = await prisma.$queryRaw<{ audioHash: string }[]>(eligibleQuery);
  return new Set(rows.map((row) => row.audioHash));
}

async function assertMcpSearchFiltersVisible(
  catalogId: string,
  filters?: SearchMetadataFilters,
): Promise<void> {
  const requestedEventIds = filters?.eventIds;
  if (requestedEventIds?.length) {
    const visibleEventIds = new Set(
      (await resolveReadableEventIds(catalogId, MCP_VISIBILITY_ACCESS_LEVEL)) ??
        [],
    );
    if (requestedEventIds.some((eventId) => !visibleEventIds.has(eventId))) {
      throw new McpReadError('not_found', 'Event not found');
    }
  }

  const requestedAudioHashes = filters?.audioHashes;
  if (!requestedAudioHashes?.length) return;
  const visibleHashes = await resolveMcpReadableRecordingHashes(
    catalogId,
    requestedAudioHashes,
  );
  if (requestedAudioHashes.some((audioHash) => !visibleHashes.has(audioHash))) {
    throw new McpReadError('not_found', 'Recording not found');
  }
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
  await assertMcpSearchFiltersVisible(catalogId, input.filters);
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
  await assertMcpSearchFiltersVisible(catalogId, input.filters);
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
  const eventSearchResults = searchResults.filter(
    (
      result,
    ): result is CatalogSearchResult & {
      event: NonNullable<CatalogSearchResult['event']>;
    } => result.event !== null && result.event !== undefined,
  );
  if (eventSearchResults.length === 0) return [];
  const audioHashes = [
    ...new Set(eventSearchResults.map((result) => result.audioHash)),
  ];
  const priorities = await listTranscriptBackendPriorities();
  const transcriptsPath = resolveTranscriptsPath(catalogId);
  const availableBackendsByHash = new Map(
    await mapWithConcurrency(
      audioHashes,
      TRANSCRIPT_BACKEND_LOOKUP_CONCURRENCY,
      async (audioHash) => {
        const available = await getAvailableTranscripts(
          transcriptsPath,
          audioHash,
          { priorities },
        );
        return [audioHash, available.backends] as const;
      },
    ),
  );

  return eventSearchResults.map((result) => {
    const transcriptStartSec =
      contextChunks > 0 ? result.contextStartSec : result.startSec;
    const transcriptEndSec =
      contextChunks > 0 ? result.contextEndSec : result.endSec;
    const transcriptBackend = resolveSearchTranscriptBackend(
      result.citation.backendKey,
      availableBackendsByHash.get(result.audioHash) ?? [],
    );
    return {
      rank: result.rank,
      event: {
        ...result.event,
        webUrl: buildEventWebUrl(catalogId, result.event.id),
      },
      recording: {
        audioHash: result.audioHash,
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
      citation: result.citation,
      transcriptRequest:
        transcriptBackend && transcriptEndSec > transcriptStartSec
          ? {
              catalogId,
              audioHash: result.audioHash,
              backend: transcriptBackend,
              mode: 'page' as const,
              startSec: transcriptStartSec,
              endSec: transcriptEndSec,
            }
          : null,
    };
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () =>
      worker(),
    ),
  );
  return results;
}
