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
import { ListEventsOutputSchema } from '@/lib/mcp/tools/output-schemas';

const DEFAULT_EVENT_PAGE_SIZE = 25;
const MAX_EVENT_PAGE_SIZE = 100;
const PartialEventDateSchema = z
  .object({
    year: z.number().int().min(1900).max(2100),
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional(),
  })
  .refine((date) => date.day === undefined || date.month !== undefined, {
    message: 'day requires month',
    path: ['day'],
  });

export function registerListEventsTool(
  server: McpServer,
  { accessProfile: profile }: BesedyMcpRequestContext,
): void {
  server.registerTool(
    'list_events',
    {
      title: 'List Besedy events',
      description:
        'List visible events in chronological date order. Uses the current user default catalog when catalogId is omitted.',
      inputSchema: z.object({
        catalogId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Accessible Besedy catalog to browse. Omit it to use the effective default catalog.',
          ),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Opaque continuation cursor returned by the previous page. Pass it back unchanged with the same catalog, order, and filters.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_EVENT_PAGE_SIZE)
          .default(DEFAULT_EVENT_PAGE_SIZE)
          .describe('Maximum events to return; defaults to 25.'),
        order: z
          .enum(['asc', 'desc'])
          .default('desc')
          .describe(
            'Chronological event-date order. Use asc for oldest events first and desc for newest events first.',
          ),
        released: z
          .boolean()
          .optional()
          .describe(
            'When supplied, include only released or only unreleased events.',
          ),
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'Case-insensitive literal match against event title, description, or location name.',
          ),
        date: PartialEventDateSchema.optional().describe(
          'Structured event date prefix. Supply only year for a year, add month for a month, or add day for an exact date.',
        ),
        locationId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Exact event location ID. Use query instead when only a location name is known.',
          ),
      }),
      outputSchema: ListEventsOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({
      catalogId,
      cursor,
      limit,
      order,
      released,
      query,
      date,
      locationId,
    }) => {
      const catalog = resolveToolCatalog(profile, catalogId, 'canListEvents');
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () =>
          listMcpEvents(catalog.id, catalog.catalogGrant, {
            cursor,
            limit,
            order,
            released,
            query,
            date,
            locationId,
          }),
        (result) =>
          `Listed ${Array.isArray(result.events) ? result.events.length : 0} visible Besedy event(s).`,
      );
    },
  );
}
