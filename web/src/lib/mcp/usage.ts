import type {
  CallToolResult,
  InputRequiredResult,
} from '@modelcontextprotocol/server';
import { McpToolOutcome } from '@/generated/prisma/enums';
import { logAccessDenied } from '@/lib/audit/logger';
import prisma from '@/lib/db';
import { createServerLogger } from '@/lib/log/server';
import { toPrismaJson } from '@/lib/prisma-json';
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
]);

type ToolResult = CallToolResult | InputRequiredResult;

interface InvocationInputSummary {
  catalogId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
}

interface InvocationResultSummary {
  outcome: McpToolOutcome;
  errorCode: string | null;
  catalogId: string | null;
  resultCount: number | null;
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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
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
  const args = asRecord(input) ?? {};
  const metadata: Record<string, unknown> = {};
  const numericKeys = [
    'limit',
    'contextChunks',
    'maxPerRecording',
    'recordingOffset',
    'recordingLimit',
    'eventOffset',
    'eventLimit',
    'segmentOffset',
    'segmentLimit',
    'maxTextChars',
    'startSec',
    'endSec',
  ] as const;

  for (const key of numericKeys) {
    const value = finiteNumber(args[key]);
    if (value !== null) metadata[key] = value;
  }

  for (const key of ['backend', 'mode'] as const) {
    const value = nonEmptyString(args[key]);
    if (value !== null) metadata[key] = value;
  }

  if (typeof args.query === 'string') {
    metadata.queryChars = args.query.length;
  }
  const filters = asRecord(args.filters);
  if (filters) {
    metadata.filterKeys = Object.keys(filters).sort();
  }

  const audioHash = nonEmptyString(args.audioHash);
  const eventId = finiteNumber(args.eventId);

  return {
    catalogId: nonEmptyString(args.catalogId),
    targetType: audioHash ? 'recording' : eventId !== null ? 'event' : null,
    targetId: audioHash ?? (eventId !== null ? String(eventId) : null),
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
  };
}

export function summarizeMcpInvocationResult(
  toolName: string,
  result: ToolResult,
): InvocationResultSummary {
  const resultRecord = asRecord(result);
  const structured = asRecord(resultRecord?.structuredContent);
  const error = asRecord(structured?.error);
  const errorCode = nonEmptyString(error?.code);
  const isError = resultRecord?.isError === true || errorCode !== null;
  const denied = errorCode === 'permission_denied';
  const segments = asRecord(structured?.segments);
  const retrieval = asRecord(structured?.retrieval);

  let resultCount: number | null = null;
  for (const key of [
    'catalogs',
    'locations',
    'recorders',
    'events',
    'results',
  ]) {
    const count = arrayLength(structured?.[key]);
    if (count !== null) {
      resultCount = count;
      break;
    }
  }
  resultCount ??= arrayLength(segments?.items);
  resultCount ??= finiteNumber(retrieval?.returnedCount);
  if (
    resultCount === null &&
    !isError &&
    ['who_am_i', 'get_event', 'get_recording'].includes(toolName)
  ) {
    resultCount = 1;
  }

  return {
    outcome: denied
      ? McpToolOutcome.DENIED
      : isError
        ? McpToolOutcome.ERROR
        : McpToolOutcome.SUCCESS,
    errorCode,
    catalogId: nonEmptyString(structured?.catalogId),
    resultCount,
    returnedTextChars: finiteNumber(segments?.returnedTextChars),
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
        targetType: params.input.targetType,
        targetId: params.input.targetId,
        outcome: params.result.outcome,
        errorCode: params.result.errorCode,
        durationMs: params.durationMs,
        resultCount: params.result.resultCount,
        returnedTextChars: params.result.returnedTextChars,
        metadata: toPrismaJson(params.input.metadata),
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
      result: summarizeMcpInvocationResult(toolName, result),
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
        resultCount: null,
        returnedTextChars: null,
      },
    });
    throw error;
  }
}
