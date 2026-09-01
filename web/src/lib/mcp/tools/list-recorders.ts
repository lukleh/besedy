import type { McpServer } from '@modelcontextprotocol/server';
import { listMcpRecorders } from '@/lib/mcp/read-service';
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
import { ListRecordersOutputSchema } from '@/lib/mcp/tools/output-schemas';

function renderRecorderListContent(
  result: Awaited<ReturnType<typeof listMcpRecorders>>,
  summary: string,
): string {
  return renderMcpListContent(
    summary,
    result.recorders.map(
      (recorder) =>
        `${recorder.id} · ${recorder.name} · ${recorder.recordingCount} recording(s)`,
    ),
    result.nextCursor,
  );
}

export function registerListRecordersTool(
  server: McpServer,
  context: BesedyMcpRequestContext,
): void {
  const { accessProfile: profile } = context;
  registerBesedyTool(
    server,
    context,
    'list_recorders',
    {
      title: 'List Besedy recorders',
      description: 'List recorder IDs available for transcript search filters.',
      inputSchema: createLookupListInputSchema('recorder'),
      outputSchema: ListRecordersOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ catalogId, query, cursor, limit }) => {
      const catalog = resolveToolCatalog(profile, catalogId);
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () =>
          listMcpRecorders(catalog.id, {
            query,
            cursor,
            limit,
          }),
        (result) =>
          `Listed ${Array.isArray(result.recorders) ? result.recorders.length : 0} recorder(s).`,
        renderRecorderListContent,
      );
    },
  );
}
