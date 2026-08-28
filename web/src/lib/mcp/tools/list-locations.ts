import type { McpServer } from '@modelcontextprotocol/server';
import { listMcpLocations } from '@/lib/mcp/read-service';
import {
  createLookupListInputSchema,
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';

export function registerListLocationsTool(
  server: McpServer,
  context: BesedyMcpRequestContext,
): void {
  const { accessProfile: profile } = context;
  registerBesedyTool(
    server,
    context,
    'list_locations',
    {
      title: 'List Besedy locations',
      description:
        'Discover location IDs used by visible recordings or events before filtering list_events or search_transcripts. Uses the current user default catalog when catalogId is omitted.',
      inputSchema: createLookupListInputSchema('location'),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ catalogId, query, cursor, limit }) => {
      const catalog = resolveToolCatalog(
        profile,
        catalogId,
        'canGetRecordings',
      );
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () =>
          listMcpLocations(
            catalog.id,
            catalog.catalogGrant,
            catalog.capabilities.canListEvents,
            { query, cursor, limit },
          ),
        (result) =>
          `Listed ${Array.isArray(result.locations) ? result.locations.length : 0} visible Besedy location(s).`,
      );
    },
  );
}
