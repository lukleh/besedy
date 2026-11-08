import type { CallToolResult } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpToolOutcome } from '@/generated/prisma/enums';

const mocks = vi.hoisted(() => ({
  createInvocation: vi.fn(),
  logAccessDenied: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  default: {
    mcpToolInvocation: { create: mocks.createInvocation },
  },
}));

vi.mock('@/lib/audit/logger', () => ({
  logAccessDenied: mocks.logAccessDenied,
}));

vi.mock('@/lib/log/server', () => ({
  createServerLogger: () => ({ error: mocks.loggerError }),
}));

import {
  summarizeMcpInvocationResult,
  trackMcpToolInvocation,
} from '@/lib/mcp/usage';

const context = {
  clientId: 'client-1',
  clientName: 'Codex',
  scopes: ['besedy:read'],
  accessProfile: {
    userId: 'user-1',
    canEnterPortal: true,
    archive: { id: 'catalog-1', label: 'Archive' },
  },
};

describe('MCP usage telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createInvocation.mockResolvedValue({ id: 'invocation-1' });
    mocks.logAccessDenied.mockResolvedValue(undefined);
  });

  it('extracts transcript volume without retaining transcript content', () => {
    const result = {
      content: [{ type: 'text' as const, text: 'private transcript text' }],
      structuredContent: {
        catalogId: 'catalog-1',
        segments: {
          items: [{ text: 'private transcript text' }],
        },
      },
    } satisfies CallToolResult;

    expect(summarizeMcpInvocationResult(result)).toEqual({
      outcome: McpToolOutcome.SUCCESS,
      errorCode: null,
      catalogId: 'catalog-1',
      returnedTextChars: 23,
    });
  });

  it('records successful calls with user and OAuth-client attribution', async () => {
    const result = {
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: {
        catalogId: 'catalog-1',
        results: [{ rank: 1 }, { rank: 2 }],
      },
    } satisfies CallToolResult;

    await expect(
      trackMcpToolInvocation(
        context,
        'search_transcripts',
        () => result,
      ),
    ).resolves.toBe(result);

    expect(mocks.createInvocation).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'user-1',
        userId: 'user-1',
        clientId: 'client-1',
        clientName: 'Codex',
        toolName: 'search_transcripts',
        catalogId: 'catalog-1',
        outcome: McpToolOutcome.SUCCESS,
      }),
    });
    expect(mocks.logAccessDenied).not.toHaveBeenCalled();
  });

  it('normalizes and bounds untrusted OAuth client names', async () => {
    const result = {
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { account: {} },
    } satisfies CallToolResult;
    const unsafeClientName = `Injected\nMCP\u0000\u001b ACTIVITY\u2028\u202e${'x'.repeat(300)}`;

    await trackMcpToolInvocation(
      { ...context, clientName: unsafeClientName },
      'who_am_i',
      () => result,
    );

    const clientName = mocks.createInvocation.mock.calls[0][0].data.clientName;
    expect(clientName).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(Array.from(clientName)).toHaveLength(255);
    expect(clientName).toMatch(/^Injected MCP ACTIVITY x+$/u);
  });

  it('bounds result source IDs to the database column width', async () => {
    const result = {
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { catalogId: `catalog-${'x'.repeat(300)}`, events: [] },
    } satisfies CallToolResult;

    await trackMcpToolInvocation(
      context,
      'list_events',
      () => result,
    );

    const catalogId = mocks.createInvocation.mock.calls[0][0].data.catalogId;
    expect(Array.from(catalogId)).toHaveLength(191);
  });

  it('attributes archive reads without assigning an archive to identity calls', async () => {
    const result = {
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { events: [] },
    } satisfies CallToolResult;

    await trackMcpToolInvocation(context, 'list_events', () => result);
    await trackMcpToolInvocation(context, 'who_am_i', () => result);

    expect(mocks.createInvocation).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ catalogId: 'catalog-1' }),
    });
    expect(mocks.createInvocation).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ catalogId: null }),
    });
  });

  it('records and mirrors permission denials into the security audit log', async () => {
    const result = {
      isError: true,
      content: [{ type: 'text' as const, text: 'denied' }],
      structuredContent: {
        error: {
          code: 'permission_denied',
          message: 'denied',
          retryable: false,
        },
      },
    } satisfies CallToolResult;

    await trackMcpToolInvocation(
      context,
      'get_transcript',
      () => result,
    );

    expect(mocks.createInvocation).toHaveBeenCalledWith({
      data: expect.objectContaining({
        outcome: McpToolOutcome.DENIED,
        errorCode: 'permission_denied',
      }),
    });
    expect(mocks.logAccessDenied).toHaveBeenCalledWith(
      'user-1',
      'mcp',
      'get_transcript',
      expect.objectContaining({
        clientId: 'client-1',
        catalogId: 'catalog-1',
        errorCode: 'permission_denied',
      }),
    );
  });

  it('records unexpected failures and preserves the original exception', async () => {
    const failure = new Error('backend failed');

    await expect(
      trackMcpToolInvocation(context, 'who_am_i', () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(mocks.createInvocation).toHaveBeenCalledWith({
      data: expect.objectContaining({
        outcome: McpToolOutcome.ERROR,
        errorCode: 'internal_error',
      }),
    });
  });

  it('does not fail a tool call when telemetry persistence is unavailable', async () => {
    mocks.createInvocation.mockRejectedValueOnce(new Error('database offline'));
    const result = {
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { account: {} },
    } satisfies CallToolResult;

    await expect(
      trackMcpToolInvocation(context, 'who_am_i', () => result),
    ).resolves.toBe(result);
    expect(mocks.loggerError).toHaveBeenCalledOnce();
  });
});
