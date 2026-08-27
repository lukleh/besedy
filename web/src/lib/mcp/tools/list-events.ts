import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { listMcpEvents } from '@/lib/mcp/read-service';
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';

const DEFAULT_EVENT_PAGE_SIZE = 25;
const MAX_EVENT_PAGE_SIZE = 100;

export function registerListEventsTool(
  server: McpServer,
  { accessProfile: profile }: BesedyMcpRequestContext,
): void {
  server.registerTool(
    'list_events',
    {
      title: 'List Besedy events',
      description:
        'List visible events in a catalog. Uses the current user default catalog when catalogId is omitted.',
      inputSchema: z.object({
        catalogId: z.string().min(1).optional(),
        cursor: z.number().int().positive().optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_EVENT_PAGE_SIZE)
          .default(DEFAULT_EVENT_PAGE_SIZE),
        released: z.boolean().optional(),
        query: z.string().trim().min(1).max(200).optional(),
      }),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ catalogId, cursor, limit, released, query }) => {
      const catalog = resolveToolCatalog(profile, catalogId, 'canListEvents');
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () =>
          listMcpEvents(catalog.id, catalog.catalogGrant, {
            cursor,
            limit,
            released,
            query,
          }),
        (result) =>
          `Listed ${Array.isArray(result.events) ? result.events.length : 0} visible Besedy event(s).`,
      );
    },
  );
}
