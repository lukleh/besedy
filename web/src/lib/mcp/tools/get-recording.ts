import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMcpRecording } from '@/lib/mcp/read-service';
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { HashSchema } from '@/lib/validation/schemas';
import { GetRecordingOutputSchema } from '@/lib/mcp/tools/output-schemas';

export function registerGetRecordingTool(
  server: McpServer,
  context: BesedyMcpRequestContext,
): void {
  const { accessProfile: profile } = context;
  registerBesedyTool(
    server,
    context,
    'get_recording',
    {
      title: 'Get Besedy recording metadata',
      description:
        'Get recording-specific metadata. Search results already provide event context.',
      inputSchema: z.object({
        catalogId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Accessible Besedy catalog containing the recording. Omit it to use the effective default catalog.',
          ),
        audioHash: HashSchema.describe(
          'Stable recording hash returned by an event, search, or transcript response.',
        ),
      }),
      outputSchema: GetRecordingOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ catalogId, audioHash }) => {
      const catalog = resolveToolCatalog(profile, catalogId);
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () => getMcpRecording(catalog.id, audioHash),
        () => `Returned recording ${audioHash}.`,
      );
    },
  );
}
