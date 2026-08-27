import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SearchMetadataFiltersSchema } from '@/app/api/catalogs/[id]/search/search-route-helpers';
import { searchMcpTranscripts } from '@/lib/mcp/read-service';
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 20;
const MAX_SEARCH_CONTEXT_CHUNKS = 3;
const DEFAULT_SEARCH_RESULTS_PER_RECORDING = 3;
const MAX_SEARCH_RESULTS_PER_RECORDING = 20;

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

export function registerSearchTranscriptsTool(
  server: McpServer,
  { accessProfile: profile }: BesedyMcpRequestContext,
): void {
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
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
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
