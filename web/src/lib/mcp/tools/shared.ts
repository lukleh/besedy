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
