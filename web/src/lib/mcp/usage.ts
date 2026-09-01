import type {
  CallToolResult,
  InputRequiredResult,
} from '@modelcontextprotocol/server';
import { McpToolOutcome } from '@/generated/prisma/enums';
import { logAccessDenied } from '@/lib/audit/logger';
import prisma from '@/lib/db';
import { createServerLogger } from '@/lib/log/server';
import type { BesedyMcpRequestContext } from '@/lib/mcp/tools/types';

const logger = createServerLogger('mcp-usage');
const MCP_TELEMETRY_LABEL_MAX_LENGTH = 255;
const CATALOG_SCOPED_TOOLS = new Set([
  'list_locations',
  'list_recorders',
  'list_events',
  'get_event',
  'get_recording',
  'get_transcript',
  'search_transcripts',
  'find_transcript_mentions',
]);

type ToolResult = CallToolResult | InputRequiredResult;

interface InvocationInputSummary {
  catalogId: string | null;
}

interface InvocationResultSummary {
  outcome: McpToolOutcome;
  errorCode: string | null;
  catalogId: string | null;
  returnedTextChars: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function transcriptTextChars(
  segments: Record<string, unknown> | null,
): number | null {
  const items = segments?.items;
  if (!Array.isArray(items)) return null;
  return items.reduce((total, item) => {
    const text = asRecord(item)?.text;
    return total + (typeof text === 'string' ? text.length : 0);
  }, 0);
}

function sanitizeTelemetryLabel(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized.length === 0) return null;
  if (normalized.length <= MCP_TELEMETRY_LABEL_MAX_LENGTH) return normalized;
  return Array.from(normalized)
    .slice(0, MCP_TELEMETRY_LABEL_MAX_LENGTH)
    .join('');
}

export function summarizeMcpInvocationInput(
  input: unknown,
): InvocationInputSummary {
  return { catalogId: nonEmptyString(asRecord(input)?.catalogId) };
}

export function summarizeMcpInvocationResult(
  result: ToolResult,
): InvocationResultSummary {
  const resultRecord = asRecord(result);
  const structured = asRecord(resultRecord?.structuredContent);
  const error = asRecord(structured?.error);
  const errorCode = nonEmptyString(error?.code);
  const isError = resultRecord?.isError === true || errorCode !== null;
  const denied = errorCode === 'permission_denied';
  const segments = asRecord(structured?.segments);

  return {
    outcome: denied
      ? McpToolOutcome.DENIED
      : isError
        ? McpToolOutcome.ERROR
        : McpToolOutcome.SUCCESS,
    errorCode,
    catalogId: nonEmptyString(structured?.catalogId),
    returnedTextChars: transcriptTextChars(segments),
  };
}

async function writeInvocation(params: {
  context: BesedyMcpRequestContext;
  toolName: string;
  durationMs: number;
  input: InvocationInputSummary;
  result: InvocationResultSummary;
}): Promise<void> {
  const clientName = sanitizeTelemetryLabel(params.context.clientName);
  const catalogId =
    params.result.catalogId ??
    params.input.catalogId ??
    (CATALOG_SCOPED_TOOLS.has(params.toolName)
      ? params.context.accessProfile.defaultCatalogId
      : null);
  try {
    await prisma.mcpToolInvocation.create({
      data: {
        actorUserId: params.context.accessProfile.userId,
        userId: params.context.accessProfile.userId,
        clientId: params.context.clientId,
        clientName,
        toolName: params.toolName,
        catalogId,
        outcome: params.result.outcome,
        errorCode: params.result.errorCode,
        durationMs: params.durationMs,
        returnedTextChars: params.result.returnedTextChars,
      },
    });
  } catch (error) {
    logger.error('Failed to write MCP tool invocation', error);
  }

  if (params.result.outcome === McpToolOutcome.DENIED) {
    await logAccessDenied(
      params.context.accessProfile.userId,
      'mcp',
      params.toolName,
      {
        clientId: params.context.clientId,
        clientName,
        toolName: params.toolName,
        catalogId,
        errorCode: params.result.errorCode,
      },
    );
  }
}

export async function trackMcpToolInvocation<T extends ToolResult>(
  context: BesedyMcpRequestContext,
  toolName: string,
  input: unknown,
  operation: () => T | Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const inputSummary = summarizeMcpInvocationInput(input);

  try {
    const result = await operation();
    await writeInvocation({
      context,
      toolName,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      input: inputSummary,
      result: summarizeMcpInvocationResult(result),
    });
    return result;
  } catch (error) {
    await writeInvocation({
      context,
      toolName,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      input: inputSummary,
      result: {
        outcome: McpToolOutcome.ERROR,
        errorCode: 'internal_error',
        catalogId: null,
        returnedTextChars: null,
      },
    });
    throw error;
  }
}
