import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMcpEvent } from '@/lib/mcp/read-service';
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';

const DEFAULT_EVENT_RECORDING_LIMIT = 25;
const MAX_EVENT_RECORDING_LIMIT = 100;

export function registerGetEventTool(
  server: McpServer,
  { accessProfile: profile }: BesedyMcpRequestContext,
): void {
  server.registerTool(
    'get_event',
    {
      title: 'Get a Besedy event',
      description:
        'Get one visible event and a bounded page of compact visible recording summaries.',
      inputSchema: z.object({
        catalogId: z.string().min(1).optional(),
        eventId: z.number().int().positive(),
        recordingOffset: z.number().int().min(0).default(0),
        recordingLimit: z
          .number()
          .int()
          .min(1)
          .max(MAX_EVENT_RECORDING_LIMIT)
          .default(DEFAULT_EVENT_RECORDING_LIMIT),
      }),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ catalogId, eventId, recordingOffset, recordingLimit }) => {
      const catalog = resolveToolCatalog(profile, catalogId, 'canListEvents');
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () =>
          getMcpEvent(catalog.id, eventId, catalog.catalogGrant, {
            offset: recordingOffset,
            limit: recordingLimit,
          }),
        () => `Returned Besedy event ${eventId}.`,
      );
    },
  );
}
