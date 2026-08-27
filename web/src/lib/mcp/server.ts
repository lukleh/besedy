import { McpServer } from '@modelcontextprotocol/server';
import {
  registerGetEventTool,
  registerGetRecordingTool,
  registerGetTranscriptTool,
  registerListCatalogsTool,
  registerListEventsTool,
  registerSearchTranscriptsTool,
  registerWhoAmITool,
  type BesedyMcpRequestContext,
} from '@/lib/mcp/tools';

export { paginateCatalogs } from '@/lib/mcp/tools';
export type { BesedyMcpRequestContext } from '@/lib/mcp/tools';

export function createBesedyMcpServer(
  context: BesedyMcpRequestContext,
): McpServer {
  const { accessProfile: profile } = context;
  const server = new McpServer({
    name: 'besedy',
    version: '0.1.0',
  });

  if (!profile.canEnterPortal) {
    return server;
  }

  registerWhoAmITool(server, context);
  registerListCatalogsTool(server, context);

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
