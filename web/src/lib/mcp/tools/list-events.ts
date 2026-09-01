import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { listMcpEvents } from '@/lib/mcp/read-service';
import {
  formatMcpDate,
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  renderMcpListContent,
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

function renderEventListContent(
  result: Awaited<ReturnType<typeof listMcpEvents>>,
  summary: string,
): string {
  return renderMcpListContent(
    summary,
    result.events.map(
      (event) =>
        `${formatMcpDate(event.date)} · ${event.location.name} · Event ${event.id}: ${event.webUrl}`,
    ),
    result.nextCursor,
  );
}

export function registerListEventsTool(
  server: McpServer,
  context: BesedyMcpRequestContext,
): void {
  const { accessProfile: profile } = context;
  registerBesedyTool(
    server,
    context,
    'list_events',
    {
      title: 'List Besedy events',
      description:
        'List visible events with their authoritative date and location.',
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
    async ({ catalogId, cursor, limit, order, query, date, locationId }) => {
      const catalog = resolveToolCatalog(profile, catalogId);
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () =>
          listMcpEvents(catalog.id, {
            cursor,
            limit,
            order,
            query,
            date,
            locationId,
          }),
        (result) =>
          `Listed ${Array.isArray(result.events) ? result.events.length : 0} event(s).`,
        renderEventListContent,
      );
    },
  );
}
