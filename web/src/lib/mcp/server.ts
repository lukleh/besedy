import { McpServer } from '@modelcontextprotocol/server';
import {
  registerFindTranscriptMentionsTool,
  registerGetEventTool,
  registerGetRecordingTool,
  registerGetTranscriptTool,
  registerListCatalogsTool,
  registerListEventsTool,
  registerListLocationsTool,
  registerListRecordersTool,
  registerSearchTranscriptsTool,
  registerWhoAmITool,
  type BesedyMcpRequestContext,
} from '@/lib/mcp/tools';

export { paginateCatalogs } from '@/lib/mcp/tools';
export type { BesedyMcpRequestContext } from '@/lib/mcp/tools';

export const BESEDY_MCP_INSTRUCTIONS =
  'Besedy is a large corpus of long recordings. Use find_transcript_mentions for literal words, names, phrases, prefixes, quotations, and complete-corpus literal checks; use search_transcripts for concepts, paraphrases, and language variation. For important research, combine both when useful. For ordinary content questions, use search_transcripts in two stages: first run a small orientation search to learn the corpus vocabulary and promising sources, then before synthesizing run precise broad searches informed by that orientation, using the broad default limit, multiple matches per recording when useful, and materially different reformulations. Do not wait for the user to ask for more precision. Semantic search is non-exhaustive; verify important evidence from either search by passing a result transcriptRequest to get_transcript and reading continuous context. Use smaller event- or recording-filtered follow-ups when needed. Search rank is relevance within one query, not confidence. Different recordings linked to the same event are variants of one discussion, not independent evidence; describe a theme as recurring only when distinct events support it. Prefer bounded segment webUrl values for citations. Do not infer that the corpus lacks a concept from an unsuccessful semantic search; a zero-result lexical search only establishes the absence of the selected literal token pattern under the selected filters. Use who_am_i and list_catalogs when identity, catalog selection, or permissions are unclear.';

export function createBesedyMcpServer(
  context: BesedyMcpRequestContext,
): McpServer {
  const { accessProfile: profile } = context;
  const server = new McpServer(
    {
      name: 'besedy',
      version: '0.1.0',
    },
    { instructions: BESEDY_MCP_INSTRUCTIONS },
  );

  if (!profile.canEnterPortal) {
    return server;
  }

  registerWhoAmITool(server, context);
  registerListCatalogsTool(server, context);

  if (profile.aggregate.canGetRecordings) {
    registerListLocationsTool(server, context);
    registerListRecordersTool(server, context);
  }

  if (profile.aggregate.canListEvents) {
    registerListEventsTool(server, context);
    registerGetEventTool(server, context);
  }
  if (profile.aggregate.canGetRecordings) {
    registerGetRecordingTool(server, context);
  }
  if (profile.aggregate.canViewTranscripts) {
    registerGetTranscriptTool(server, context);
  }
  if (profile.aggregate.canSearchTranscripts) {
    registerSearchTranscriptsTool(server, context);
    registerFindTranscriptMentionsTool(server, context);
  }

  return server;
}
