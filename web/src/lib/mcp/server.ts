import { McpServer } from '@modelcontextprotocol/server';
import {
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
  'Besedy is a large corpus of long recordings. Use search_transcripts for non-exhaustive semantic discovery, then verify important evidence by passing a result transcriptRequest to get_transcript and reading continuous context. For broad discovery, favor diversity across recordings; use smaller event- or recording-filtered follow-ups when needed. Search rank is relevance within one query, not confidence. Different recordings linked to the same event are variants of one discussion, not independent evidence; describe a theme as recurring only when distinct events support it. Prefer bounded segment webUrl values for citations. Do not infer that the corpus lacks a topic from an unsuccessful search. Use who_am_i and list_catalogs when identity, catalog selection, or permissions are unclear.';

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
  }

  return server;
}
