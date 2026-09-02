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
  renderTranscriptSearchResult,
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
const MAX_LEXICAL_QUERY_TOKENS = 32;
const MIN_PREFIX_TOKEN_LENGTH = 2;

function lexicalQueryTokens(query: string): string[] {
  return query.normalize('NFKC').match(/[\p{L}\p{N}\p{M}\p{Co}]+/gu) ?? [];
}

function renderSearchContent(
  result: Awaited<ReturnType<typeof findMcpTranscriptMentions>>,
): string {
  const lines = [
    `Lexical transcript search for ${JSON.stringify(result.query)} found ${result.retrieval.totalMatches} matching indexed chunk(s) across the complete authorized indexed transcript corpus and returned ${result.results.length}.`,
    'The complete count is a chunk-match count, not a distinct-event count. It covers all authorized indexed chunks under the selected filters and match mode before limit and maxPerRecording cap returned passages. A zero count establishes only indexed literal-pattern absence, not conceptual absence.',
    'Each match includes its authoritative event date, location, and ID. Group matches by event ID because recordings from the same event are variants, not independent evidence.',
  ];
  for (const searchResult of result.results) {
    lines.push(...renderTranscriptSearchResult(searchResult));
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
        'Search actual wording in the authorized indexed transcript corpus for visible released Besedy events. Use this for names, terminology, quotations, fixed phrases, prefixes, or literal absence checks; use search_transcripts instead for concepts, paraphrases, and related meaning. totalMatches counts matching authorized indexed chunks under the selected filters and match mode before limit or maxPerRecording caps returned passages; it is not a distinct-event count. A zero count establishes only indexed literal-pattern absence, not conceptual absence. Verify important returned passages by passing a non-null transcriptRequest to get_transcript and reading continuous context; do not rely on an important candidate when that request is unavailable. Every match directly includes its authoritative event ID, date, and location plus the recording audio hash that owns the transcript. Group matches by event ID because recordings from the same event are variants, not independent evidence. Each match webUrl is a bounded citation. Rank is text-match relevance, not confidence.',
      inputSchema: z
        .object({
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
            'Optional constraints. eventIds, locationIds, and dateYears apply to linked events; resolve event and location IDs with list_events and list_locations. audioHashes identify recordings. recorderIds and verified remain optional curated-recording constraints.',
          ),
        })
        .superRefine((input, context) => {
          const tokens = lexicalQueryTokens(input.query);
          if (tokens.length > MAX_LEXICAL_QUERY_TOKENS) {
            context.addIssue({
              code: 'custom',
              path: ['query'],
              message: `Query must contain at most ${MAX_LEXICAL_QUERY_TOKENS} searchable tokens.`,
            });
          }
          if (
            input.matchMode === 'prefix' &&
            tokens.some(
              (token) => Array.from(token).length < MIN_PREFIX_TOKEN_LENGTH,
            )
          ) {
            context.addIssue({
              code: 'custom',
              path: ['query'],
              message: `Prefix query tokens must contain at least ${MIN_PREFIX_TOKEN_LENGTH} characters.`,
            });
          }
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
          `Found ${result.retrieval.totalMatches} literal Besedy transcript match(es).`,
        renderSearchContent,
      );
    },
  );
}
