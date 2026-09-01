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

export const BESEDY_MCP_INSTRUCTIONS = [
  'Besedy is a read-only corpus of released events and published recordings. Base claims about its content on returned Besedy evidence.',
  'Tool descriptions and schemas define individual calls. Use search_transcripts for meaning and find_transcript_mentions for actual wording.',
  'Meaning-based search is ranked and non-exhaustive. Literal totalMatches is complete over authorized indexed chunks under the selected filters and match mode before result caps, but not over stored backend variants outside the active index.',
  'Verify important search evidence by passing a non-null transcriptRequest to get_transcript and reading coherent continuous context; do not rely on it when that request is unavailable.',
  'For cross-recording claims, use get_recording to compare their event IDs. Recordings assigned to the same event are variants, not independent evidence; support recurring themes with distinct events.',
  'Cite bounded segment webUrl values. Use who_am_i or list_catalogs only when identity, catalog selection, or permissions are unclear.',
].join(' ');

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

  registerListLocationsTool(server, context);
  registerListRecordersTool(server, context);
  registerListEventsTool(server, context);
  registerGetEventTool(server, context);
  registerGetRecordingTool(server, context);
  registerGetTranscriptTool(server, context);
  registerSearchTranscriptsTool(server, context);
  registerFindTranscriptMentionsTool(server, context);

  return server;
}
