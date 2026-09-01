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
import { ListLocationsOutputSchema } from '@/lib/mcp/tools/output-schemas';

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
        'Discover location IDs used by visible Besedy data. list_events, search_transcripts, and find_transcript_mentions apply location IDs to events, so use eventCount to identify event locations; recordingCount describes curated recording metadata only. Uses the current user default catalog when catalogId is omitted.',
      inputSchema: createLookupListInputSchema('location'),
      outputSchema: ListLocationsOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ catalogId, query, cursor, limit }) => {
      const catalog = resolveToolCatalog(profile, catalogId);
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () => listMcpLocations(catalog.id, { query, cursor, limit }),
        (result) =>
          `Listed ${Array.isArray(result.locations) ? result.locations.length : 0} visible Besedy location(s).`,
      );
    },
  );
}
