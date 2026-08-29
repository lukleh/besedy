import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  renderStructuredResult,
  toolError,
  toolSuccess,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { ListCatalogsOutputSchema } from '@/lib/mcp/tools/output-schemas';

const DEFAULT_CATALOG_PAGE_SIZE = 50;
const MAX_CATALOG_PAGE_SIZE = 100;

export function paginateCatalogs<T extends { id: string }>(
  catalogs: T[],
  cursor: string | undefined,
  requestedLimit: number,
): { items: T[]; nextCursor: string | null } | null {
  const startIndex = cursor
    ? catalogs.findIndex((catalog) => catalog.id === cursor) + 1
    : 0;
  if (cursor && startIndex === 0) return null;

  const limit = Math.max(1, Math.min(requestedLimit, MAX_CATALOG_PAGE_SIZE));
  const items = catalogs.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + items.length < catalogs.length;
  return {
    items,
    nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
  };
}

export function registerListCatalogsTool(
  server: McpServer,
  context: BesedyMcpRequestContext,
): void {
  const { accessProfile: profile } = context;
  registerBesedyTool(
    server,
    context,
    'list_catalogs',
    {
      title: 'List Besedy catalogs',
      description:
        'List the catalogs available to the current user and their uniform MCP read capabilities.',
      inputSchema: z.object({
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Catalog ID returned as nextCursor by the previous page. Pass it back unchanged.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_CATALOG_PAGE_SIZE)
          .default(DEFAULT_CATALOG_PAGE_SIZE)
          .describe('Maximum catalogs to return; defaults to 50.'),
      }),
      outputSchema: ListCatalogsOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ cursor, limit }) => {
      const page = paginateCatalogs(profile.catalogs, cursor, limit);
      if (!page) {
        return toolError('invalid_cursor', 'Invalid catalog cursor');
      }

      const result = {
        catalogs: page.items,
        defaultCatalogId: profile.defaultCatalogId,
        defaultCatalogSource: profile.defaultCatalogSource,
        nextCursor: page.nextCursor,
      };
      const summary = `Listed ${page.items.length} accessible Besedy catalog(s).`;
      return toolSuccess(result, renderStructuredResult(summary, result));
    },
  );
}
