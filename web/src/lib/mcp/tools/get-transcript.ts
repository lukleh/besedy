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
        'Get a time-windowed segment page from an accessible recording transcript, using maxTextChars as a soft target while preserving whole segments.',
      inputSchema: z.object({
        catalogId: z.string().min(1).optional(),
        audioHash: HashSchema,
        backend: TranscriptBackendSchema.optional(),
        startSec: z.number().min(0).optional(),
        endSec: z.number().positive().optional(),
        segmentOffset: z.number().int().min(0).default(0),
        segmentLimit: z
          .number()
          .int()
          .min(1)
          .max(MAX_TRANSCRIPT_SEGMENT_LIMIT)
          .default(DEFAULT_TRANSCRIPT_SEGMENT_LIMIT),
        maxTextChars: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_TRANSCRIPT_TEXT_CHAR_LIMIT)
          .default(DEFAULT_TRANSCRIPT_TEXT_CHAR_LIMIT),
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
