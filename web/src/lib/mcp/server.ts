import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  type McpAccessProfile,
  type McpCatalogAccess,
} from '@/lib/mcp/access-profile';
import { getMcpIdentity } from '@/lib/mcp/identity';
import {
  getMcpEvent,
  getMcpRecording,
  getMcpTranscript,
  listMcpEvents,
  McpReadError,
  searchMcpTranscripts,
} from '@/lib/mcp/read-service';
import { HashSchema, TranscriptBackendSchema } from '@/lib/validation/schemas';
import { SearchMetadataFiltersSchema } from '@/app/api/catalogs/[id]/search/search-route-helpers';

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
const MAX_SEARCH_CONTEXT_CHUNKS = 3;
const DEFAULT_SEARCH_RESULTS_PER_RECORDING = 3;
const MAX_SEARCH_RESULTS_PER_RECORDING = 20;

type CatalogCapabilityName = keyof McpCatalogAccess['capabilities'];

export interface BesedyMcpRequestContext {
  clientId: string;
  scopes: string[];
  accessProfile: McpAccessProfile;
}

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

function toolSuccess(result: Record<string, unknown>, contentText: string) {
  return {
    content: [{ type: 'text' as const, text: contentText }],
    structuredContent: result,
  };
}

function toolError(code: string, message: string, retryable = false) {
  const result = { error: { code, message, retryable } };
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

function renderTranscriptContent(
  result: Awaited<ReturnType<typeof getMcpTranscript>>,
): string {
  const lines = [
    `Transcript for ${result.audioHash} (${result.backend}, ${result.language ?? 'unknown language'}):`,
    ...result.segments.items.map((segment) => {
      const speaker = segment.speaker ? ` ${segment.speaker}` : '';
      return `[${segment.startSec}-${segment.endSec}s]${speaker}: ${segment.text}`;
    }),
  ];
  if (result.continuation) {
    lines.push(
      `Continue with segmentOffset ${result.continuation.segmentOffset}.`,
    );
  }
  return lines.join('\n');
}

function renderSearchContent(
  result: Awaited<ReturnType<typeof searchMcpTranscripts>>,
): string {
  const lines = [
    `Semantic transcript search for ${JSON.stringify(result.query)} returned ${result.results.length} non-exhaustive match(es).`,
  ];
  for (const searchResult of result.results) {
    lines.push(
      `${searchResult.rank}. ${searchResult.recording.title} [${searchResult.match.startSec}-${searchResult.match.endSec}s]`,
      searchResult.match.text,
    );
    if (searchResult.context?.beforeText) {
      lines.push(`Before: ${searchResult.context.beforeText}`);
    }
    if (searchResult.context?.afterText) {
      lines.push(`After: ${searchResult.context.afterText}`);
    }
    lines.push(`Source: ${searchResult.match.webUrl}`);
  }
  return lines.join('\n');
}

async function runReadTool<T extends Record<string, unknown>>(
  operation: () => Promise<T>,
  summarize: (result: T) => string,
  renderContent?: (result: T) => string,
) {
  try {
    const result = await operation();
    return toolSuccess(result, renderContent?.(result) ?? summarize(result));
  } catch (error) {
    if (error instanceof McpReadError) {
      return toolError(error.code, error.message, error.retryable);
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

export function createBesedyMcpServer({
  clientId,
  scopes,
  accessProfile: profile,
}: BesedyMcpRequestContext): McpServer {
  const userId = profile.userId;
  const server = new McpServer({
    name: 'besedy',
    version: '0.1.0',
  });

  if (!profile.canEnterPortal) {
    return server;
  }

  server.registerTool(
    'who_am_i',
    {
      title: 'Show current Besedy identity',
      description:
        'Show which Besedy account and OAuth client this MCP connection is using, including its effective access summary.',
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => {
      const identity = await getMcpIdentity(userId, clientId);
      if (!identity) {
        return toolError(
          'identity_unavailable',
          'The authenticated Besedy account is no longer available',
        );
      }

      const canReadProfile = scopes.includes('profile');
      const canReadEmail = scopes.includes('email');
      const result = {
        account: {
          id: identity.userId,
          name: canReadProfile ? identity.name : null,
          email: canReadEmail ? identity.email : null,
          emailVerified: canReadEmail ? identity.emailVerified : null,
          status: canReadProfile ? profile.userStatus : null,
          systemRole: canReadProfile ? profile.systemRole : null,
        },
        authorization: {
          clientId: identity.clientId,
          clientName: identity.clientName,
          grantedScopes: scopes,
          accessibleCatalogCount: profile.catalogs.length,
          defaultCatalogId: profile.defaultCatalogId,
        },
      };
      const accountLabel =
        result.account.email ?? result.account.name ?? identity.userId;
      const roleLabel = canReadProfile ? ` (${profile.systemRole})` : '';
      return toolSuccess(
        result,
        `Connected to Besedy as ${accountLabel}${roleLabel} via ${identity.clientName ?? identity.clientId}.`,
      );
    },
  );

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
          'Get a time-windowed segment page from an accessible recording transcript, using maxTextChars as a soft target while preserving whole segments.',
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
          renderTranscriptContent,
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
          contextChunks: z
            .number()
            .int()
            .min(0)
            .max(MAX_SEARCH_CONTEXT_CHUNKS)
            .default(0),
          maxPerRecording: z
            .number()
            .int()
            .min(1)
            .max(MAX_SEARCH_RESULTS_PER_RECORDING)
            .default(DEFAULT_SEARCH_RESULTS_PER_RECORDING),
          filters: SearchMetadataFiltersSchema.optional(),
        }),
        annotations: readOnlyAnnotations,
      },
      async ({
        catalogId,
        query,
        limit,
        contextChunks,
        maxPerRecording,
        filters,
      }) => {
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
              contextChunks,
              maxPerRecording,
              filters,
            }),
          (result) =>
            `Found ${Array.isArray(result.results) ? result.results.length : 0} Besedy transcript match(es).`,
          renderSearchContent,
        );
      },
    );
  }

  return server;
}
