import type { McpServer } from '@modelcontextprotocol/server';
import { listMcpLocations } from '@/lib/mcp/read-service';
import {
  createLookupListInputSchema,
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  renderMcpListContent,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { ListLocationsOutputSchema } from '@/lib/mcp/tools/output-schemas';

function renderLocationListContent(
  result: Awaited<ReturnType<typeof listMcpLocations>>,
  summary: string,
): string {
  return renderMcpListContent(
    summary,
    result.locations.map(
      (location) =>
        `${location.id} · ${location.name} · ${location.eventCount} event(s)`,
    ),
    result.nextCursor,
  );
}

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
        'List locations used by visible events for locationId filters.',
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
          `Listed ${Array.isArray(result.locations) ? result.locations.length : 0} event location(s).`,
        renderLocationListContent,
      );
    },
  );
}
