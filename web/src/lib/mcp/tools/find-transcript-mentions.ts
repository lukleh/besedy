import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  LexicalMatchModeSchema,
  MAX_PER_AUDIO_LIMIT,
  SearchMetadataFiltersSchema,
} from '@/app/api/catalogs/[id]/search/search-route-helpers';
import { findMcpTranscriptMentions } from '@/lib/mcp/read-service';
import { FindTranscriptMentionsOutputSchema } from '@/lib/mcp/tools/output-schemas';
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const DEFAULT_SEARCH_CONTEXT_CHUNKS = 1;
const MAX_SEARCH_CONTEXT_CHUNKS = 3;
const DEFAULT_SEARCH_RESULTS_PER_RECORDING = 10;

function renderSearchContent(
  result: Awaited<ReturnType<typeof findMcpTranscriptMentions>>,
): string {
  const lines = [
    `Lexical transcript search for ${JSON.stringify(result.query)} found ${result.retrieval.totalMatches} complete-corpus match(es) and returned ${result.results.length}.`,
    'The complete count covers the authorized catalog, filters, and match mode before limit and maxPerRecording cap returned passages. A zero count establishes only literal-pattern absence, not conceptual absence.',
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

export function registerFindTranscriptMentionsTool(
  server: McpServer,
  context: BesedyMcpRequestContext,
): void {
  const { accessProfile: profile } = context;
  registerBesedyTool(
    server,
    context,
    'find_transcript_mentions',
    {
      title: 'Find exact transcript mentions',
      description:
        'Search actual transcript wording across accessible Besedy recordings. Use this for names, terminology, quotations, fixed phrases, prefixes, or literal absence checks; use search_transcripts instead for concepts, paraphrases, and related meaning. totalMatches is the complete count under the authorized catalog, selected filters, and match mode before limit or maxPerRecording caps the returned passages. A zero count establishes only that literal pattern is absent in that scope, not that the underlying concept is absent. Verify important returned passages by passing transcriptRequest to get_transcript and reading continuous context. Each match webUrl is a bounded citation; each recording summary webUrl remains unbounded. Rank is text-match relevance, not confidence.',
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
          .refine(
            (value) => /[\p{L}\p{N}]/u.test(value),
            'Query must contain a searchable letter or number.',
          )
          .describe(
            'Literal words or phrase to find. Search operators are not accepted; punctuation is safely tokenized.',
          ),
        matchMode: LexicalMatchModeSchema.default('all_terms').describe(
          'How query tokens must match: all_terms requires every token in a chunk, phrase requires adjacency and order, any_term accepts any token, and prefix matches the beginning of every token.',
        ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_LIMIT)
          .default(DEFAULT_SEARCH_LIMIT)
          .describe(
            'Maximum returned matches, from 1 to 200. This does not limit the complete totalMatches count.',
          ),
        contextChunks: z
          .number()
          .int()
          .min(0)
          .max(MAX_SEARCH_CONTEXT_CHUNKS)
          .default(DEFAULT_SEARCH_CONTEXT_CHUNKS)
          .describe(
            'Number of mechanically adjacent indexed chunks to return before and after each match.',
          ),
        maxPerRecording: z
          .number()
          .int()
          .min(1)
          .max(MAX_PER_AUDIO_LIMIT)
          .default(DEFAULT_SEARCH_RESULTS_PER_RECORDING)
          .describe(
            'Maximum matches returned per recording/audio hash. This does not limit the complete totalMatches count.',
          ),
        filters: SearchMetadataFiltersSchema.optional().describe(
          'Optional constraints. Resolve filters.locationIds and filters.recorderIds with list_locations and list_recorders. Use filters.eventIds for events selected with list_events, or filters.audioHashes for specific recordings.',
        ),
      }),
      outputSchema: FindTranscriptMentionsOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({
      catalogId,
      query,
      matchMode,
      limit,
      contextChunks,
      maxPerRecording,
      filters,
    }) => {
      const catalog = resolveToolCatalog(profile, catalogId);
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () =>
          findMcpTranscriptMentions(catalog.id, {
            query,
            matchMode,
            limit,
            contextChunks,
            maxPerRecording,
            filters,
          }),
        (result) =>
          `Found ${typeof result.retrieval?.totalMatches === 'number' ? result.retrieval.totalMatches : 0} literal Besedy transcript match(es).`,
        renderSearchContent,
      );
    },
  );
}
