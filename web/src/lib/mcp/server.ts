import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  getMcpAccessProfile,
  type McpAccessProfile,
  type McpCatalogAccess,
} from '@/lib/mcp/access-profile';
import {
  getMcpEvent,
  getMcpRecording,
  getMcpTranscript,
  listMcpEvents,
  McpReadError,
  searchMcpTranscripts,
} from '@/lib/mcp/read-service';
import { HashSchema, TranscriptBackendSchema } from '@/lib/validation/schemas';

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const DEFAULT_CATALOG_PAGE_SIZE = 50;
const MAX_CATALOG_PAGE_SIZE = 100;
const DEFAULT_EVENT_PAGE_SIZE = 25;
const MAX_EVENT_PAGE_SIZE = 100;
const DEFAULT_EVENT_RECORDING_LIMIT = 25;
const MAX_EVENT_RECORDING_LIMIT = 100;
const DEFAULT_RECORDING_EVENT_LIMIT = 25;
const MAX_RECORDING_EVENT_LIMIT = 100;
const DEFAULT_TRANSCRIPT_SEGMENT_LIMIT = 50;
const MAX_TRANSCRIPT_SEGMENT_LIMIT = 200;
const DEFAULT_TRANSCRIPT_TEXT_CHAR_LIMIT = 20_000;
const MAX_TRANSCRIPT_TEXT_CHAR_LIMIT = 50_000;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 20;

type CatalogCapabilityName = keyof McpCatalogAccess['capabilities'];

function resolveToolCatalog(
  profile: McpAccessProfile,
  catalogId: string | undefined,
  requiredCapability: CatalogCapabilityName,
): McpCatalogAccess | { error: string; code: string } {
  const resolvedId = catalogId ?? profile.defaultCatalogId ?? undefined;
  if (!resolvedId) {
    return {
      code: 'catalog_required',
      error:
        'No accessible default catalog is available; provide catalogId explicitly',
    };
  }
  const catalog = profile.catalogs.find((entry) => entry.id === resolvedId);
  if (!catalog) {
    return {
      code: 'not_found',
      error: 'Catalog not found or inaccessible',
    };
  }
  if (!catalog.capabilities[requiredCapability]) {
    return {
      code: 'permission_denied',
      error: `Catalog permission does not allow ${requiredCapability}`,
    };
  }
  return catalog;
}

function toolSuccess(result: Record<string, unknown>, summary: string) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: result,
  };
}

function toolError(code: string, message: string) {
  const result = { error: { code, message } };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function getPageItemCount(page: unknown): number {
  if (!page || typeof page !== 'object') return 0;
  const items = (page as { items?: unknown }).items;
  return Array.isArray(items) ? items.length : 0;
}

async function runReadTool(
  operation: () => Promise<Record<string, unknown>>,
  summarize: (result: Record<string, unknown>) => string,
) {
  try {
    const result = await operation();
    return toolSuccess(result, summarize(result));
  } catch (error) {
    if (error instanceof McpReadError) {
      return toolError(error.code, error.message);
    }
    throw error;
  }
}

export function paginateCatalogs<T extends { id: string }>(
  catalogs: T[],
  cursor: string | undefined,
  requestedLimit: number,
): { items: T[]; nextCursor: string | null } | null {
  const startIndex = cursor
    ? catalogs.findIndex((catalog) => catalog.id === cursor) + 1
    : 0;
  if (cursor && startIndex === 0) return null;

  const limit = Math.max(1, Math.min(requestedLimit, MAX_CATALOG_PAGE_SIZE));
  const items = catalogs.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + items.length < catalogs.length;
  return {
    items,
    nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
  };
}

export async function createBesedyMcpServer(
  userId: string,
): Promise<McpServer> {
  const profile = await getMcpAccessProfile(userId);
  const server = new McpServer({
    name: 'besedy',
    version: '0.1.0',
  });

  if (!profile.canEnterPortal) {
    return server;
  }

  server.registerTool(
    'list_catalogs',
    {
      title: 'List Besedy catalogs',
      description:
        'List the catalogs available to the current user and the read capabilities allowed in each catalog.',
      inputSchema: z.object({
        cursor: z.string().min(1).optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_CATALOG_PAGE_SIZE)
          .default(DEFAULT_CATALOG_PAGE_SIZE),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ cursor, limit }) => {
      const page = paginateCatalogs(profile.catalogs, cursor, limit);
      if (!page) {
        return toolError('invalid_cursor', 'Invalid catalog cursor');
      }

      const result = {
        catalogs: page.items,
        defaultCatalogId: profile.defaultCatalogId,
        defaultCatalogSource: profile.defaultCatalogSource,
        nextCursor: page.nextCursor,
      };
      return toolSuccess(
        result,
        `Listed ${page.items.length} accessible Besedy catalog(s).`,
      );
    },
  );

  if (profile.aggregate.canListEvents) {
    server.registerTool(
      'list_events',
      {
        title: 'List Besedy events',
        description:
          'List visible events in a catalog. Uses the current user default catalog when catalogId is omitted.',
        inputSchema: z.object({
          catalogId: z.string().min(1).optional(),
          cursor: z.number().int().positive().optional(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_EVENT_PAGE_SIZE)
            .default(DEFAULT_EVENT_PAGE_SIZE),
          released: z.boolean().optional(),
          query: z.string().trim().min(1).max(200).optional(),
        }),
        annotations: readOnlyAnnotations,
      },
      async ({ catalogId, cursor, limit, released, query }) => {
        const catalog = resolveToolCatalog(profile, catalogId, 'canListEvents');
        if ('error' in catalog) return toolError(catalog.code, catalog.error);
        return runReadTool(
          () =>
            listMcpEvents(catalog.id, catalog.catalogGrant, {
              cursor,
              limit,
              released,
              query,
            }),
          (result) =>
            `Listed ${Array.isArray(result.events) ? result.events.length : 0} visible Besedy event(s).`,
        );
      },
    );

    server.registerTool(
      'get_event',
      {
        title: 'Get a Besedy event',
        description:
          'Get one visible event and a bounded page of compact visible recording summaries.',
        inputSchema: z.object({
          catalogId: z.string().min(1).optional(),
          eventId: z.number().int().positive(),
          recordingOffset: z.number().int().min(0).default(0),
          recordingLimit: z
            .number()
            .int()
            .min(1)
            .max(MAX_EVENT_RECORDING_LIMIT)
            .default(DEFAULT_EVENT_RECORDING_LIMIT),
        }),
        annotations: readOnlyAnnotations,
      },
      async ({ catalogId, eventId, recordingOffset, recordingLimit }) => {
        const catalog = resolveToolCatalog(profile, catalogId, 'canListEvents');
        if ('error' in catalog) return toolError(catalog.code, catalog.error);
        return runReadTool(
          () =>
            getMcpEvent(catalog.id, eventId, catalog.catalogGrant, {
              offset: recordingOffset,
              limit: recordingLimit,
            }),
          () => `Returned Besedy event ${eventId}.`,
        );
      },
    );
  }

  if (profile.aggregate.canGetRecordings) {
    server.registerTool(
      'get_recording',
      {
        title: 'Get Besedy recording metadata',
        description:
          'Get metadata for one visible recording and a bounded page of its visible events, without returning audio or filesystem paths.',
        inputSchema: z.object({
          catalogId: z.string().min(1).optional(),
          audioHash: HashSchema,
          eventOffset: z.number().int().min(0).default(0),
          eventLimit: z
            .number()
            .int()
            .min(1)
            .max(MAX_RECORDING_EVENT_LIMIT)
            .default(DEFAULT_RECORDING_EVENT_LIMIT),
        }),
        annotations: readOnlyAnnotations,
      },
      async ({ catalogId, audioHash, eventOffset, eventLimit }) => {
        const catalog = resolveToolCatalog(
          profile,
          catalogId,
          'canGetRecordings',
        );
        if ('error' in catalog) return toolError(catalog.code, catalog.error);
        return runReadTool(
          () =>
            getMcpRecording(userId, catalog.id, audioHash, {
              offset: eventOffset,
              limit: eventLimit,
            }),
          () => `Returned metadata for Besedy recording ${audioHash}.`,
        );
      },
    );
  }

  if (profile.aggregate.canViewTranscripts) {
    server.registerTool(
      'get_transcript',
      {
        title: 'Get a Besedy transcript',
        description:
          'Get a time-windowed, character-bounded segment page from an accessible recording transcript.',
        inputSchema: z.object({
          catalogId: z.string().min(1).optional(),
          audioHash: HashSchema,
          backend: TranscriptBackendSchema.optional(),
          startSec: z.number().min(0).optional(),
          endSec: z.number().positive().optional(),
          segmentOffset: z.number().int().min(0).default(0),
          segmentLimit: z
            .number()
            .int()
            .min(1)
            .max(MAX_TRANSCRIPT_SEGMENT_LIMIT)
            .default(DEFAULT_TRANSCRIPT_SEGMENT_LIMIT),
          maxTextChars: z
            .number()
            .int()
            .min(1_000)
            .max(MAX_TRANSCRIPT_TEXT_CHAR_LIMIT)
            .default(DEFAULT_TRANSCRIPT_TEXT_CHAR_LIMIT),
        }),
        annotations: readOnlyAnnotations,
      },
      async ({
        catalogId,
        audioHash,
        backend,
        startSec,
        endSec,
        segmentOffset,
        segmentLimit,
        maxTextChars,
      }) => {
        const catalog = resolveToolCatalog(
          profile,
          catalogId,
          'canViewTranscripts',
        );
        if ('error' in catalog) return toolError(catalog.code, catalog.error);
        return runReadTool(
          () =>
            getMcpTranscript(userId, catalog.id, audioHash, {
              backend,
              startSec,
              endSec,
              segmentOffset,
              segmentLimit,
              maxTextChars,
            }),
          (result) =>
            `Returned ${getPageItemCount(result.segments)} transcript segment(s) for Besedy recording ${audioHash}.`,
        );
      },
    );
  }

  if (profile.aggregate.canSearchTranscripts) {
    server.registerTool(
      'search_transcripts',
      {
        title: 'Search Besedy transcripts',
        description:
          'Search accessible transcript chunks with Besedy RAG and return grounded citations.',
        inputSchema: z.object({
          catalogId: z.string().min(1).optional(),
          query: z.string().trim().min(1).max(1_000),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_SEARCH_LIMIT)
            .default(DEFAULT_SEARCH_LIMIT),
          includeNeighbors: z.boolean().default(false),
        }),
        annotations: readOnlyAnnotations,
      },
      async ({ catalogId, query, limit, includeNeighbors }) => {
        const catalog = resolveToolCatalog(
          profile,
          catalogId,
          'canSearchTranscripts',
        );
        if ('error' in catalog) return toolError(catalog.code, catalog.error);
        return runReadTool(
          () =>
            searchMcpTranscripts(catalog.id, catalog.catalogGrant, {
              query,
              limit,
              includeNeighbors,
            }),
          (result) =>
            `Found ${Array.isArray(result.results) ? result.results.length : 0} Besedy transcript match(es).`,
        );
      },
    );
  }

  return server;
}
