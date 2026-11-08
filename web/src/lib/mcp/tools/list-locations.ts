import type { McpServer } from '@modelcontextprotocol/server';
import { listMcpLocations } from '@/lib/mcp/read-service';
import {
  createLookupListInputSchema,
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  renderMcpListContent,
  resolveToolArchive,
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
    async ({ query, cursor, limit }) => {
      const archive = resolveToolArchive(profile);
      if ('error' in archive) return toolError(archive.code, archive.error);
      return runReadTool(
        () => listMcpLocations(archive.id, { query, cursor, limit }),
        (result) => `Listed ${result.locations.length} event location(s).`,
        renderLocationListContent,
      );
    },
  );
}
