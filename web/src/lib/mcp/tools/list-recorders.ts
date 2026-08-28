import type { McpServer } from '@modelcontextprotocol/server';
import { listMcpRecorders } from '@/lib/mcp/read-service';
import {
  createLookupListInputSchema,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { ListRecordersOutputSchema } from '@/lib/mcp/tools/output-schemas';

export function registerListRecordersTool(
  server: McpServer,
  { accessProfile: profile }: BesedyMcpRequestContext,
): void {
  server.registerTool(
    'list_recorders',
    {
      title: 'List Besedy recorders',
      description:
        'Discover recorder IDs used by visible recordings before filtering search_transcripts. Uses the current user default catalog when catalogId is omitted.',
      inputSchema: createLookupListInputSchema('recorder'),
      outputSchema: ListRecordersOutputSchema,
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
          listMcpRecorders(catalog.id, catalog.catalogGrant, {
            query,
            cursor,
            limit,
          }),
        (result) =>
          `Listed ${Array.isArray(result.recorders) ? result.recorders.length : 0} visible Besedy recorder(s).`,
      );
    },
  );
}
