import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMcpRecording } from '@/lib/mcp/read-service';
import {
  formatMcpDate,
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { HashSchema } from '@/lib/validation/schemas';
import { GetRecordingOutputSchema } from '@/lib/mcp/tools/output-schemas';

function renderRecordingContent(
  result: Awaited<ReturnType<typeof getMcpRecording>>,
): string {
  const { recording, event } = result;
  const lines = [
    `Recording: ${recording.audioHash} ${recording.webUrl}`,
    `Title: ${recording.title}`,
  ];
  if (event) {
    lines.push(
      `Event: ${formatMcpDate(event.date)} · ${event.location.name} · ${event.id} ${event.webUrl}${event.isPrimary ? ' · primary recording' : ''}`,
    );
  } else {
    lines.push('Event: none visible.');
  }
  const metadata = [
    recording.artist ? `artist=${recording.artist}` : null,
    recording.album ? `album=${recording.album.name}` : null,
    recording.durationHms ? `duration=${recording.durationHms}` : null,
    recording.date.year === null
      ? null
      : `date=${formatMcpDate(recording.date)}`,
    recording.location ? `location=${recording.location.name}` : null,
    recording.recorder ? `recorder=${recording.recorder.name}` : null,
    `verified=${recording.verified ? 'yes' : 'no'}`,
    recording.sourceDate ? `sourceDate=${recording.sourceDate}` : null,
  ].filter((value): value is string => value !== null);
  if (metadata.length > 0) lines.push(`Metadata: ${metadata.join('; ')}`);
  if (recording.tags.length > 0) {
    lines.push(`Tags: ${recording.tags.join(', ')}`);
  }
  if (recording.notes) lines.push(`Notes: ${recording.notes}`);
  return lines.join('\n');
}

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
        renderRecordingContent,
      );
    },
  );
}
