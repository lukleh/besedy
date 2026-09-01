import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMcpEvent } from '@/lib/mcp/read-service';
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { GetEventOutputSchema } from '@/lib/mcp/tools/output-schemas';

const DEFAULT_EVENT_RECORDING_LIMIT = 25;
const MAX_EVENT_RECORDING_LIMIT = 100;

export function registerGetEventTool(
  server: McpServer,
  context: BesedyMcpRequestContext,
): void {
  const { accessProfile: profile } = context;
  registerBesedyTool(
    server,
    context,
    'get_event',
    {
      title: 'Get a Besedy event',
      description: 'Get one visible event and its recording identifiers.',
      inputSchema: z.object({
        catalogId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Accessible Besedy catalog containing the event. Omit it to use the effective default catalog.',
          ),
        eventId: z
          .number()
          .int()
          .positive()
          .describe('Stable event ID returned by list_events.'),
        recordingOffset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            'Offset into visible attached recordings; use the previous nextOffset to continue.',
          ),
        recordingLimit: z
          .number()
          .int()
          .min(1)
          .max(MAX_EVENT_RECORDING_LIMIT)
          .default(DEFAULT_EVENT_RECORDING_LIMIT)
          .describe('Maximum recording summaries to return; defaults to 25.'),
      }),
      outputSchema: GetEventOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ catalogId, eventId, recordingOffset, recordingLimit }) => {
      const catalog = resolveToolCatalog(profile, catalogId);
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () =>
          getMcpEvent(catalog.id, eventId, {
            offset: recordingOffset,
            limit: recordingLimit,
          }),
        () => `Returned event ${eventId}.`,
      );
    },
  );
}
