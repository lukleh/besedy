import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMcpAccessProfile } from '@/lib/mcp/access-profile';

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

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

export async function createBesedyMcpServer(
  userId: string,
): Promise<McpServer> {
  const profile = await getMcpAccessProfile(userId);
  const server = new McpServer({
    name: 'besedy',
    version: '0.1.0',
  });

  if (!profile.canEnterPortal) {
    return server;
  }

  server.registerTool(
    'list_catalogs',
    {
      title: 'List Besedy catalogs',
      description:
        'List the catalogs available to the current user and the read capabilities allowed in each catalog.',
      inputSchema: z.object({
        cursor: z.string().min(1).optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_CATALOG_PAGE_SIZE)
          .default(DEFAULT_CATALOG_PAGE_SIZE),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ cursor, limit }) => {
      const page = paginateCatalogs(profile.catalogs, cursor, limit);
      if (!page) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Invalid catalog cursor' }],
        };
      }

      const result = {
        catalogs: page.items,
        defaultCatalogId: profile.defaultCatalogId,
        defaultCatalogSource: profile.defaultCatalogSource,
        nextCursor: page.nextCursor,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  // Further tools are registered here only when the aggregate profile permits
  // them. Their handlers must still authorize the resolved target catalog.
  // This first vertical slice intentionally ships catalog discovery before the
  // event/transcript/search service extraction is complete.

  return server;
}
