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
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';
import { trackMcpToolInvocation } from '@/lib/mcp/usage';

const DEFAULT_LOOKUP_PAGE_SIZE = 50;
const MAX_LOOKUP_PAGE_SIZE = 100;

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

export function renderStructuredResult(
  summary: string,
  result: Record<string, unknown>,
): string {
  return `${summary}\nStructured result: ${JSON.stringify(result)}`;
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

function formatEventDate(
  date: RenderableTranscriptSearchResult['event']['date'],
) {
  const month =
    date.month === null ? null : String(date.month).padStart(2, '0');
  const day = date.day === null ? null : String(date.day).padStart(2, '0');
  if (month === null) return String(date.year);
  return day === null
    ? `${date.year}-${month}`
    : `${date.year}-${month}-${day}`;
}

export function renderTranscriptSearchResult(
  result: RenderableTranscriptSearchResult,
): string[] {
  const lines = [
    `${result.rank}. ${formatEventDate(result.event.date)} · ${result.event.location.name} [${result.match.startSec}-${result.match.endSec}s]`,
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
  renderContent?: (result: T) => string,
) {
  try {
    const result = await operation();
    const summary = summarize(result);
    return toolSuccess(
      result,
      renderContent?.(result) ?? renderStructuredResult(summary, result),
    );
  } catch (error) {
    if (error instanceof McpReadError) {
      return toolError(error.code, error.message, error.retryable);
    }
    throw error;
  }
}
