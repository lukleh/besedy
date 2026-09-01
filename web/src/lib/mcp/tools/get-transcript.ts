import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMcpTranscript } from '@/lib/mcp/read-service';
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { HashSchema, TranscriptBackendSchema } from '@/lib/validation/schemas';
import { GetTranscriptOutputSchema } from '@/lib/mcp/tools/output-schemas';

const DEFAULT_TRANSCRIPT_SEGMENT_LIMIT = 50;
const MAX_TRANSCRIPT_SEGMENT_LIMIT = 200;
const DEFAULT_TRANSCRIPT_TEXT_CHAR_LIMIT = 20_000;
const MAX_TRANSCRIPT_TEXT_CHAR_LIMIT = 50_000;

function getPageItemCount(page: unknown): number {
  if (!page || typeof page !== 'object') return 0;
  const items = (page as { items?: unknown }).items;
  return Array.isArray(items) ? items.length : 0;
}

function renderTranscriptContent(
  result: Awaited<ReturnType<typeof getMcpTranscript>>,
): string {
  const lines = [
    `Transcript for ${result.audioHash} (${result.backend}, ${result.language ?? 'unknown language'}):`,
    ...result.segments.items.flatMap((segment) => {
      const speaker = segment.speaker ? ` ${segment.speaker}` : '';
      return [
        `[${segment.startSec}-${segment.endSec}s]${speaker}: ${segment.text}`,
        `Source: ${segment.webUrl}`,
      ];
    }),
  ];
  if (result.continuation) {
    lines.push(
      `Continue with segmentOffset ${result.continuation.segmentOffset}.`,
    );
  }
  return lines.join('\n');
}

export function registerGetTranscriptTool(
  server: McpServer,
  context: BesedyMcpRequestContext,
): void {
  const { accessProfile: profile } = context;
  registerBesedyTool(
    server,
    context,
    'get_transcript',
    {
      title: 'Get a Besedy transcript',
      description:
        'Read continuous source context or the complete stored transcript from an accessible Besedy recording. To verify important evidence from either search tool, pass its non-null transcriptRequest here unchanged so the catalog, recording, backend, and time window remain aligned; expand the window when needed until the question, answer, and qualifications are coherent. If the search result has no transcriptRequest, this tool cannot verify that candidate through the indexed transcript handoff. Use mode full for every segment in the optional time window, or mode page for a bounded read. The response preserves the unbounded recordingWebUrl, provides seekWebUrl for the first returned segment, and gives every segment a bounded citation webUrl.',
      inputSchema: z
        .object({
          catalogId: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Accessible Besedy catalog containing the recording. Omit it to use the effective default catalog.',
            ),
          audioHash: HashSchema.describe(
            'Stable audio hash of the recording. Copy it from a search result or recording response.',
          ),
          backend: TranscriptBackendSchema.optional().describe(
            'Stored transcript backend to read. Prefer the backend supplied by a transcript search result transcriptRequest; omit it to use the highest-priority available backend.',
          ),
          startSec: z
            .number()
            .min(0)
            .optional()
            .describe(
              'Optional inclusive start of the continuous transcript time window, in seconds.',
            ),
          endSec: z
            .number()
            .positive()
            .optional()
            .describe(
              'Optional exclusive end of the continuous transcript time window, in seconds. It must be greater than startSec when both are provided.',
            ),
          mode: z
            .enum(['full', 'page'])
            .describe(
              'Use full to return every segment matching the optional time window in one response. Use page for bounded reading with pagination controls.',
            ),
          segmentOffset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              'Page mode only. Zero-based offset within matching segments; defaults to 0. Use continuation.segmentOffset for the next page.',
            ),
          segmentLimit: z
            .number()
            .int()
            .min(1)
            .max(MAX_TRANSCRIPT_SEGMENT_LIMIT)
            .optional()
            .describe(
              'Page mode only. Maximum whole transcript segments to return; defaults to 50 and is capped at 200.',
            ),
          maxTextChars: z
            .number()
            .int()
            .min(1_000)
            .max(MAX_TRANSCRIPT_TEXT_CHAR_LIMIT)
            .optional()
            .describe(
              'Page mode only. Soft character target; defaults to 20,000. Whole segments are preserved, so one unusually large segment may exceed it.',
            ),
        })
        .superRefine((input, context) => {
          if (input.mode !== 'full') return;
          for (const field of [
            'segmentOffset',
            'segmentLimit',
            'maxTextChars',
          ] as const) {
            if (input[field] !== undefined) {
              context.addIssue({
                code: 'custom',
                message: `${field} is only valid in page mode`,
                path: [field],
              });
            }
          }
        }),
      outputSchema: GetTranscriptOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({
      catalogId,
      audioHash,
      backend,
      startSec,
      endSec,
      mode,
      segmentOffset,
      segmentLimit,
      maxTextChars,
    }) => {
      const catalog = resolveToolCatalog(profile, catalogId);
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () =>
          getMcpTranscript(catalog.id, audioHash, {
            backend,
            startSec,
            endSec,
            ...(mode === 'full'
              ? { mode }
              : {
                  mode,
                  segmentOffset: segmentOffset ?? 0,
                  segmentLimit:
                    segmentLimit ?? DEFAULT_TRANSCRIPT_SEGMENT_LIMIT,
                  maxTextChars:
                    maxTextChars ?? DEFAULT_TRANSCRIPT_TEXT_CHAR_LIMIT,
                }),
          }),
        (result) =>
          `Returned ${getPageItemCount(result.segments)} transcript segment(s) for Besedy recording ${audioHash}.`,
        renderTranscriptContent,
      );
    },
  );
}
