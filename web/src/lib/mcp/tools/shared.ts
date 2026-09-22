import type {
  Icon,
  McpServer,
  RegisteredTool,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type {
  McpAccessProfile,
  McpCatalogAccess,
} from '@/lib/mcp/access-profile';
import { McpReadError } from '@/lib/mcp/read-service';
import { createServerLogger } from '@/lib/log/server';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { trackMcpToolInvocation } from '@/lib/mcp/usage';
import {
  searchesPrimaryRecordingsOnly,
  type SearchMetadataFilters,
} from '@/app/api/catalogs/[id]/search/search-route-helpers';

const DEFAULT_LOOKUP_PAGE_SIZE = 50;
const MAX_LOOKUP_PAGE_SIZE = 100;
const logger = createServerLogger('mcp-tools');

// Shared by the server instructions, both search tool descriptions, and the
// rendered search text so the verification step cannot drift between them.
// An unchanged transcriptRequest replays exactly the passage the search already
// returned; verification only adds context when the window widens.
export const TRANSCRIPT_VERIFICATION_GUIDANCE =
  "Verify important evidence with get_transcript: copy the result's transcriptRequest, widen startSec and endSec, then call the tool; unchanged values only replay that passage. Do not rely on an important candidate when the request is unavailable.";

const PARALLEL_CAPTURES_NOTE =
  'other recordings of the same event are parallel captures of the same session, not independent evidence.';

/**
 * Explain which recordings a search covered, based on the filters that were
 * applied. Mirrors searchesPrimaryRecordingsOnly so the explanatory text can
 * never contradict the result set.
 */
export function describeSearchedRecordings(
  filters: SearchMetadataFilters | null | undefined,
  itemNoun: 'candidate' | 'match',
): string {
  const lead = `Each ${itemNoun} includes its authoritative event date, location, and ID.`;
  if (filters?.audioHashes && filters.audioHashes.length > 0) {
    return `${lead} Only the recordings named in filters.audioHashes were searched, whether or not they are their event's primary recording; ${PARALLEL_CAPTURES_NOTE}`;
  }
  if (searchesPrimaryRecordingsOnly(filters)) {
    return `${lead} Only each event's primary recording was searched; ${PARALLEL_CAPTURES_NOTE} Set filters.includeSecondaryRecordings to true to search them as well.`;
  }
  return `${lead} Secondary recordings were included because filters.includeSecondaryRecordings is true; ${PARALLEL_CAPTURES_NOTE} Group results by event ID.`;
}

export function createLookupListInputSchema(itemName: string) {
  return z.object({
    catalogId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Accessible Besedy catalog to inspect. Omit it to use the effective default catalog.',
      ),
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        `Case-insensitive substring match against the ${itemName} name.`,
      ),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Opaque continuation cursor returned by the previous page. Pass it back unchanged with the same catalog and query.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LOOKUP_PAGE_SIZE)
      .default(DEFAULT_LOOKUP_PAGE_SIZE)
      .describe(`Maximum ${itemName}s to return; defaults to 50.`),
  });
}

export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

interface BesedyToolConfig<
  InputArgs extends StandardSchemaWithJSON,
  OutputArgs extends StandardSchemaWithJSON,
> {
  title?: string;
  description?: string;
  inputSchema: InputArgs;
  outputSchema: OutputArgs;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
}

export function registerBesedyTool<
  OutputArgs extends StandardSchemaWithJSON,
  InputArgs extends StandardSchemaWithJSON,
>(
  server: McpServer,
  context: BesedyMcpRequestContext,
  name: string,
  config: BesedyToolConfig<InputArgs, OutputArgs>,
  callback: ToolCallback<InputArgs>,
): RegisteredTool {
  const trackedCallback = (async (args, serverContext) =>
    trackMcpToolInvocation(context, name, args, () =>
      callback(args, serverContext),
    )) as ToolCallback<InputArgs>;

  return server.registerTool(name, config, trackedCallback);
}

export function resolveToolCatalog(
  profile: McpAccessProfile,
  catalogId: string | undefined,
): McpCatalogAccess | { error: string; code: string } {
  const resolvedId = catalogId ?? profile.defaultCatalogId ?? undefined;
  if (!resolvedId) {
    return {
      code: 'catalog_required',
      error:
        'No accessible default catalog is available; provide catalogId explicitly',
    };
  }
  const catalog = profile.catalogs.find((entry) => entry.id === resolvedId);
  if (!catalog) {
    return {
      code: 'not_found',
      error: 'Catalog not found or inaccessible',
    };
  }
  return catalog;
}

export function toolSuccess(
  result: Record<string, unknown>,
  contentText: string,
) {
  return {
    content: [{ type: 'text' as const, text: contentText }],
    structuredContent: result,
  };
}

export function renderTranscriptVerificationHandoff(
  transcriptRequest: unknown,
): string {
  if (transcriptRequest === null || transcriptRequest === undefined) {
    return 'Transcript request unavailable: no compatible stored transcript was found for this indexed candidate. Do not rely on it as important evidence unless another source can be verified.';
  }
  return `Transcript request: ${JSON.stringify(transcriptRequest)}`;
}

interface RenderableTranscriptSearchResult {
  rank: number;
  event: {
    id: number;
    webUrl: string;
    date: { year: number; month: number | null; day: number | null };
    location: { name: string };
  };
  recording: { audioHash: string };
  match: {
    startSec: number;
    endSec: number;
    text: string;
    webUrl: string;
  };
  context: {
    beforeText: string | null;
    afterText: string | null;
  } | null;
  transcriptRequest: unknown;
}

export function formatMcpDate(date: {
  year: number | null;
  month: number | null;
  day: number | null;
}) {
  if (date.year === null) return 'unknown date';
  const month =
    date.month === null ? null : String(date.month).padStart(2, '0');
  const day = date.day === null ? null : String(date.day).padStart(2, '0');
  if (month === null) return String(date.year);
  return day === null
    ? `${date.year}-${month}`
    : `${date.year}-${month}-${day}`;
}

export function renderMcpListContent(
  summary: string,
  items: string[],
  nextCursor: string | null,
): string {
  const lines = [summary, ...items];
  if (nextCursor) lines.push(`Next cursor: ${nextCursor}`);
  return lines.join('\n');
}

export function renderTranscriptSearchResult(
  result: RenderableTranscriptSearchResult,
): string[] {
  const lines = [
    `${result.rank}. ${formatMcpDate(result.event.date)} · ${result.event.location.name} [${result.match.startSec}-${result.match.endSec}s]`,
    `Event: ${result.event.id} ${result.event.webUrl}`,
    `Recording: ${result.recording.audioHash}`,
    result.match.text,
  ];
  if (result.context?.beforeText) {
    lines.push(`Before: ${result.context.beforeText}`);
  }
  if (result.context?.afterText) {
    lines.push(`After: ${result.context.afterText}`);
  }
  lines.push(
    `Source: ${result.match.webUrl}`,
    renderTranscriptVerificationHandoff(result.transcriptRequest),
  );
  return lines;
}

export function toolError(code: string, message: string, retryable = false) {
  const result = { error: { code, message, retryable } };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

export async function runReadTool<T extends Record<string, unknown>>(
  operation: () => Promise<T>,
  summarize: (result: T) => string,
  renderContent?: (result: T, summary: string) => string,
) {
  try {
    const result = await operation();
    const summary = summarize(result);
    return toolSuccess(result, renderContent?.(result, summary) ?? summary);
  } catch (error) {
    if (error instanceof McpReadError) {
      return toolError(error.code, error.message, error.retryable);
    }
    logger.error('Unexpected MCP read-tool failure', error);
    return toolError(
      'internal_error',
      'The tool could not complete because of an internal error',
      true,
    );
  }
}
