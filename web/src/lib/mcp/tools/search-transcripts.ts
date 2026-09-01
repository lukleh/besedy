import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  MAX_PER_AUDIO_LIMIT,
  SearchMetadataFiltersSchema,
} from '@/app/api/catalogs/[id]/search/search-route-helpers';
import { searchMcpTranscripts } from '@/lib/mcp/read-service';
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { SearchTranscriptsOutputSchema } from '@/lib/mcp/tools/output-schemas';

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const DEFAULT_SEARCH_CONTEXT_CHUNKS = 1;
const MAX_SEARCH_CONTEXT_CHUNKS = 3;
const DEFAULT_SEARCH_RESULTS_PER_RECORDING = 10;

function renderSearchContent(
  result: Awaited<ReturnType<typeof searchMcpTranscripts>>,
): string {
  const lines = [
    `Meaning-based transcript search for ${JSON.stringify(result.query)} returned ${result.results.length} ranked, non-exhaustive candidate(s).`,
    'A zero result does not establish conceptual absence. Verify important candidates by passing their transcriptRequest to get_transcript.',
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
    lines.push(
      `Source: ${searchResult.match.webUrl}`,
      `Transcript request: ${JSON.stringify(searchResult.transcriptRequest)}`,
    );
  }
  return lines.join('\n');
}

export function registerSearchTranscriptsTool(
  server: McpServer,
  context: BesedyMcpRequestContext,
): void {
  const { accessProfile: profile } = context;
  registerBesedyTool(
    server,
    context,
    'search_transcripts',
    {
      title: 'Search transcripts by meaning',
      description:
        'Find candidate passages by meaning across accessible Besedy transcripts. Use this for questions, themes, related concepts, paraphrases, and different wording; use find_transcript_mentions instead for actual words, names, quotations, fixed phrases, prefixes, or literal absence checks. Results are ranked and non-exhaustive, so a zero result does not establish conceptual absence. For ordinary meaning-based or exploratory questions, use a small first pass for orientation, then run precise broad searches before synthesizing; exact literal lookups do not need semantic orientation. Stop when the evidence adequately covers the user request. Adjacent chunks are only for triage: verify important evidence by passing transcriptRequest to get_transcript and reading coherent continuous context. Use filters.eventIds or filters.audioHashes for focused follow-ups. Each match webUrl is a bounded citation; each recording summary webUrl remains unbounded. Rank is relevance within this query, not confidence.',
      inputSchema: z.object({
        catalogId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Accessible Besedy catalog to search. Omit it to use the effective default catalog.',
          ),
        query: z
          .string()
          .trim()
          .min(1)
          .max(1_000)
          .describe(
            'Natural-language question or description of the meaning to find. Meaningfully different formulations may surface different candidate passages.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_LIMIT)
          .default(DEFAULT_SEARCH_LIMIT)
          .describe(
            'Maximum number of non-exhaustive matches to return. The broad precision default is 50 and the maximum is 200. Use a smaller limit only for initial orientation or a tightly focused follow-up, not as the final evidence base for an ordinary content question.',
          ),
        contextChunks: z
          .number()
          .int()
          .min(0)
          .max(MAX_SEARCH_CONTEXT_CHUNKS)
          .default(DEFAULT_SEARCH_CONTEXT_CHUNKS)
          .describe(
            'Number of mechanically adjacent indexed chunks to return before and after each match. This context is for candidate triage and may not preserve a complete question, answer, qualification, or discussion arc.',
          ),
        maxPerRecording: z
          .number()
          .int()
          .min(1)
          .max(MAX_PER_AUDIO_LIMIT)
          .default(DEFAULT_SEARCH_RESULTS_PER_RECORDING)
          .describe(
            'Maximum matches per recording/audio hash. A low value such as 1 favors diversity during initial orientation; for precise broad searches, keep the default or raise it when distinct passages from one recording may matter.',
          ),
        filters: SearchMetadataFiltersSchema.optional().describe(
          'Optional constraints. Resolve filters.locationIds and filters.recorderIds with list_locations and list_recorders. Use filters.eventIds for events selected with list_events, or filters.audioHashes for recordings shortlisted by an earlier broad search.',
        ),
      }),
      outputSchema: SearchTranscriptsOutputSchema,
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
      const catalog = resolveToolCatalog(profile, catalogId);
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () =>
          searchMcpTranscripts(catalog.id, {
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
