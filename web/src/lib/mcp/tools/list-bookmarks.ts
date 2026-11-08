import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { listMcpBookmarks } from '@/lib/mcp/read-service';
import {
  formatMcpDate,
  READ_ONLY_TOOL_ANNOTATIONS,
  registerBesedyTool,
  renderMcpListContent,
  renderTranscriptVerificationHandoff,
  resolveToolArchive,
  runReadTool,
  toolError,
} from '@/lib/mcp/tools/shared';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { HashSchema } from '@/lib/validation/schemas';
import { ListBookmarksOutputSchema } from '@/lib/mcp/tools/output-schemas';

const DEFAULT_BOOKMARK_PAGE_SIZE = 50;
const MAX_BOOKMARK_PAGE_SIZE = 100;

function renderBookmarkListContent(
  result: Awaited<ReturnType<typeof listMcpBookmarks>>,
  summary: string,
): string {
  return renderMcpListContent(
    summary,
    result.bookmarks.flatMap((bookmark) => {
      const lines = [
        `${bookmark.id} · ${bookmark.recording.title} [${bookmark.positionSec}s] ${bookmark.webUrl}`,
        bookmark.event
          ? `Event: ${formatMcpDate(bookmark.event.date)} · ${bookmark.event.location.name} · ${bookmark.event.id}`
          : 'Event: none visible.',
        `Recording: ${bookmark.recording.audioHash}`,
      ];
      if (bookmark.comment) lines.push(`User comment: ${bookmark.comment}`);
      if (bookmark.excerpt) lines.push(`Saved excerpt: ${bookmark.excerpt}`);
      lines.push(
        renderTranscriptVerificationHandoff(bookmark.transcriptRequest),
      );
      return lines;
    }),
    result.nextCursor,
  );
}

export function registerListBookmarksTool(
  server: McpServer,
  context: BesedyMcpRequestContext,
): void {
  const { accessProfile: profile } = context;
  registerBesedyTool(
    server,
    context,
    'list_bookmarks',
    {
      title: 'List my Besedy bookmarks',
      description:
        "List the signed-in user's own bookmarks in released recordings, newest first, with their comments. A bookmark marks a moment the user found worth returning to; its comment is the user's own note, so treat it as their interest or opinion and never cite it as what was said. Copy a bookmark's transcriptRequest into get_transcript to read the passage, and rely on that transcript rather than the saved excerpt.",
      inputSchema: z.strictObject({
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'Case-insensitive substring match against the bookmark comment and saved excerpt.',
          ),
        audioHash: HashSchema.transform((value) => value.toLowerCase())
          .optional()
          .describe('Only list bookmarks in this recording.'),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Opaque continuation cursor returned by the previous page. Pass it back unchanged with the same filters.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_BOOKMARK_PAGE_SIZE)
          .default(DEFAULT_BOOKMARK_PAGE_SIZE)
          .describe('Maximum bookmarks to return; defaults to 50.'),
      }),
      outputSchema: ListBookmarksOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ query, audioHash, cursor, limit }) => {
      const archive = resolveToolArchive(profile);
      if ('error' in archive) return toolError(archive.code, archive.error);
      return runReadTool(
        () =>
          listMcpBookmarks(profile.userId, archive.id, {
            query,
            audioHash,
            cursor,
            limit,
          }),
        (result) => `Listed ${result.bookmarks.length} bookmark(s).`,
        renderBookmarkListContent,
      );
    },
  );
}
