import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMcpRecording } from '@/lib/mcp/read-service';
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { HashSchema } from '@/lib/validation/schemas';

const DEFAULT_RECORDING_EVENT_LIMIT = 25;
const MAX_RECORDING_EVENT_LIMIT = 100;

export function registerGetRecordingTool(
  server: McpServer,
  { accessProfile: profile }: BesedyMcpRequestContext,
): void {
  server.registerTool(
    'get_recording',
    {
      title: 'Get Besedy recording metadata',
      description:
        'Get metadata for one visible recording and a bounded page of its visible events, without returning audio or filesystem paths.',
      inputSchema: z.object({
        catalogId: z.string().min(1).optional(),
        audioHash: HashSchema,
        eventOffset: z.number().int().min(0).default(0),
        eventLimit: z
          .number()
          .int()
          .min(1)
          .max(MAX_RECORDING_EVENT_LIMIT)
          .default(DEFAULT_RECORDING_EVENT_LIMIT),
      }),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ catalogId, audioHash, eventOffset, eventLimit }) => {
      const catalog = resolveToolCatalog(
        profile,
        catalogId,
        'canGetRecordings',
      );
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () =>
          getMcpRecording(profile.userId, catalog.id, audioHash, {
            offset: eventOffset,
            limit: eventLimit,
          }),
        () => `Returned metadata for Besedy recording ${audioHash}.`,
      );
    },
  );
}
