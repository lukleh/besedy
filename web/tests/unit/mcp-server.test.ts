import { createMcpHandler } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBesedyMcpServer, paginateCatalogs } from '@/lib/mcp/server';
import { getMcpAccessProfile } from '@/lib/mcp/access-profile';
import { getMcpTranscript, listMcpEvents } from '@/lib/mcp/read-service';

vi.mock('@/lib/mcp/access-profile', () => ({
  getMcpAccessProfile: vi.fn(),
}));

vi.mock('@/lib/mcp/read-service', () => ({
  McpReadError: class McpReadError extends Error {},
  listMcpEvents: vi.fn(),
  getMcpEvent: vi.fn(),
  getMcpRecording: vi.fn(),
  getMcpTranscript: vi.fn(),
  searchMcpTranscripts: vi.fn(),
}));

const envelope = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': {
    name: 'mcp-server-test',
    version: '1.0.0',
  },
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function invokeMcp(method: string, params: Record<string, unknown> = {}) {
  const handler = createMcpHandler(() => createBesedyMcpServer('user-1'), {
    legacy: 'reject',
    responseMode: 'json',
  });
  const name = typeof params.name === 'string' ? params.name : null;
  const response = await handler.fetch(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(name ? { 'mcp-name': name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { ...params, _meta: envelope },
      }),
    }),
  );
  return response.json() as Promise<{
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  }>;
}

function catalog(
  id: string,
  accessLevel: 'LISTENER' | 'VIEWER',
  isEffectiveDefault: boolean,
) {
  const elevated = accessLevel === 'VIEWER';
  return {
    id,
    label: id,
    isUserDefault: isEffectiveDefault,
    isGlobalDefault: false,
    isEffectiveDefault,
    accessLevel,
    capabilities: {
      canListEvents: true,
      canGetRecordings: true,
      canViewTranscripts: elevated,
      canSearchTranscripts: elevated,
      canSeeUnreleasedEvents: elevated,
    },
  } as const;
}

describe('MCP server catalog pagination', () => {
  const catalogs = Array.from({ length: 105 }, (_, index) => ({
    id: `catalog-${String(index).padStart(3, '0')}`,
  }));

  it('returns stable bounded pages', () => {
    const first = paginateCatalogs(catalogs, undefined, 100);
    expect(first?.items).toHaveLength(100);
    expect(first?.nextCursor).toBe('catalog-099');

    const second = paginateCatalogs(
      catalogs,
      first?.nextCursor ?? undefined,
      100,
    );
    expect(second?.items).toEqual(catalogs.slice(100));
    expect(second?.nextCursor).toBeNull();
  });

  it('rejects an unknown cursor and clamps oversized internal calls', () => {
    expect(paginateCatalogs(catalogs, 'missing', 50)).toBeNull();
    expect(paginateCatalogs(catalogs, undefined, 1_000)?.items).toHaveLength(
      100,
    );
  });
});

describe('MCP personalized tool surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits transcript-derived tools for a listener-only user', async () => {
    vi.mocked(getMcpAccessProfile).mockResolvedValue({
      userId: 'user-1',
      canEnterPortal: true,
      defaultCatalogId: 'listener-catalog',
      defaultCatalogSource: 'default',
      catalogs: [catalog('listener-catalog', 'LISTENER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: false,
        canSearchTranscripts: false,
      },
    });

    const body = await invokeMcp('tools/list');
    const tools = body.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_catalogs',
      'list_events',
      'get_event',
      'get_recording',
    ]);
  });

  it('exposes the complete read surface when any catalog permits it', async () => {
    vi.mocked(getMcpAccessProfile).mockResolvedValue({
      userId: 'user-1',
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'preference',
      catalogs: [
        catalog('listener-catalog', 'LISTENER', false),
        catalog('viewer-catalog', 'VIEWER', true),
      ],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    });

    const body = await invokeMcp('tools/list');
    const tools = body.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_catalogs',
      'list_events',
      'get_event',
      'get_recording',
      'get_transcript',
      'search_transcripts',
    ]);
  });

  it('uses the effective default catalog when catalogId is omitted', async () => {
    vi.mocked(getMcpAccessProfile).mockResolvedValue({
      userId: 'user-1',
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    });
    vi.mocked(listMcpEvents).mockResolvedValue({
      catalogId: 'viewer-catalog',
      events: [],
      nextCursor: null,
    });

    const body = await invokeMcp('tools/call', {
      name: 'list_events',
      arguments: {},
    });

    expect(body.error).toBeUndefined();
    expect(listMcpEvents).toHaveBeenCalledWith('viewer-catalog', 'VIEWER', {
      cursor: undefined,
      limit: 25,
      released: undefined,
      query: undefined,
    });
    expect(body.result?.content).toEqual([
      { type: 'text', text: 'Listed 0 visible Besedy event(s).' },
    ]);
    expect(body.result?.structuredContent).toEqual({
      catalogId: 'viewer-catalog',
      events: [],
      nextCursor: null,
    });
  });

  it('still denies a transcript call against a listener catalog', async () => {
    vi.mocked(getMcpAccessProfile).mockResolvedValue({
      userId: 'user-1',
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'preference',
      catalogs: [
        catalog('listener-catalog', 'LISTENER', false),
        catalog('viewer-catalog', 'VIEWER', true),
      ],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    });

    const body = await invokeMcp('tools/call', {
      name: 'get_transcript',
      arguments: {
        catalogId: 'listener-catalog',
        audioHash: 'a'.repeat(64),
      },
    });
    const structuredContent = body.result?.structuredContent as {
      error: { code: string };
    };
    expect(structuredContent.error.code).toBe('permission_denied');
    expect(getMcpTranscript).not.toHaveBeenCalled();
  });
});
