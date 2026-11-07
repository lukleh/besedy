import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMcpEvent } from '@/lib/mcp/read-service';
import {
  formatMcpDate,
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  resolveToolArchive,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { GetEventOutputSchema } from '@/lib/mcp/tools/output-schemas';

const DEFAULT_EVENT_RECORDING_LIMIT = 25;
const MAX_EVENT_RECORDING_LIMIT = 100;

function renderEventContent(
  result: Awaited<ReturnType<typeof getMcpEvent>>,
): string {
  const { event } = result;
  const lines = [
    `${formatMcpDate(event.date)} · ${event.location.name} · Event ${event.id}`,
    `Event: ${event.webUrl}`,
  ];
  if (event.title) lines.push(`Title: ${event.title}`);
  lines.push(
    ...event.recordings.items.map(
      (recording) =>
        `${recording.isPrimary ? 'Primary recording' : 'Recording'}: ${recording.audioHash} ${recording.webUrl}`,
    ),
    `Visible recordings: ${event.recordings.totalVisible}.`,
  );
  if (event.recordings.nextOffset !== null) {
    lines.push(`Continue with recordingOffset ${event.recordings.nextOffset}.`);
  }
  return lines.join('\n');
}

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
      inputSchema: z.strictObject({
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
    async ({ eventId, recordingOffset, recordingLimit }) => {
      const archive = resolveToolArchive(profile);
      if ('error' in archive) return toolError(archive.code, archive.error);
      return runReadTool(
        () =>
          getMcpEvent(archive.id, eventId, {
            offset: recordingOffset,
            limit: recordingLimit,
          }),
        () => `Returned event ${eventId}.`,
        renderEventContent,
      );
    },
  );
}
