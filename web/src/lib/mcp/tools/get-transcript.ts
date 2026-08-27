import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMcpTranscript } from '@/lib/mcp/read-service';
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveToolCatalog,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { HashSchema, TranscriptBackendSchema } from '@/lib/validation/schemas';

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
    ...result.segments.items.map((segment) => {
      const speaker = segment.speaker ? ` ${segment.speaker}` : '';
      return `[${segment.startSec}-${segment.endSec}s]${speaker}: ${segment.text}`;
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
  { accessProfile: profile }: BesedyMcpRequestContext,
): void {
  server.registerTool(
    'get_transcript',
    {
      title: 'Get a Besedy transcript',
      description:
        'Read continuous source context from an accessible Besedy recording transcript, typically after shortlisting a passage with search_transcripts. Use this tool to verify important evidence before relying on it in a synthesis. The response preserves the recording-level URL, provides seekWebUrl for the first segment actually returned (or null for an empty page), and gives every segment its own timestamped webUrl.',
      inputSchema: z.object({
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
          'Stored transcript backend to read. Prefer the backend supplied by search_transcripts.transcriptRequest; omit it to use the highest-priority available backend.',
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
        segmentOffset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            'Zero-based offset within the segments matching the requested time window. Use continuation.segmentOffset to fetch the next page.',
          ),
        segmentLimit: z
          .number()
          .int()
          .min(1)
          .max(MAX_TRANSCRIPT_SEGMENT_LIMIT)
          .default(DEFAULT_TRANSCRIPT_SEGMENT_LIMIT)
          .describe(
            'Maximum whole transcript segments to return in this page. Defaults to 50 and is capped at 200.',
          ),
        maxTextChars: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_TRANSCRIPT_TEXT_CHAR_LIMIT)
          .default(DEFAULT_TRANSCRIPT_TEXT_CHAR_LIMIT)
          .describe(
            'Soft character target for this page. Whole segments are preserved, so one unusually large segment may exceed it.',
          ),
      }),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({
      catalogId,
      audioHash,
      backend,
      startSec,
      endSec,
      segmentOffset,
      segmentLimit,
      maxTextChars,
    }) => {
      const catalog = resolveToolCatalog(
        profile,
        catalogId,
        'canViewTranscripts',
      );
      if ('error' in catalog) return toolError(catalog.code, catalog.error);
      return runReadTool(
        () =>
          getMcpTranscript(profile.userId, catalog.id, audioHash, {
            backend,
            startSec,
            endSec,
            segmentOffset,
            segmentLimit,
            maxTextChars,
          }),
        (result) =>
          `Returned ${getPageItemCount(result.segments)} transcript segment(s) for Besedy recording ${audioHash}.`,
        renderTranscriptContent,
      );
    },
  );
}
