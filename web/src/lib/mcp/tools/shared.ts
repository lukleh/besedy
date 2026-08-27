import type {
  McpAccessProfile,
  McpCatalogAccess,
} from '@/lib/mcp/access-profile';
import { McpReadError } from '@/lib/mcp/read-service';

export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

type CatalogCapabilityName = keyof McpCatalogAccess['capabilities'];

export function resolveToolCatalog(
  profile: McpAccessProfile,
  catalogId: string | undefined,
  requiredCapability: CatalogCapabilityName,
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
  if (!catalog.capabilities[requiredCapability]) {
    return {
      code: 'permission_denied',
      error: `Catalog permission does not allow ${requiredCapability}`,
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
    return toolSuccess(result, renderContent?.(result) ?? summarize(result));
  } catch (error) {
    if (error instanceof McpReadError) {
      return toolError(error.code, error.message, error.retryable);
    }
    throw error;
  }
}
