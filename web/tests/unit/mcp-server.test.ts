import { createMcpHandler } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBesedyMcpServer, paginateCatalogs } from '@/lib/mcp/server';
import type {
  McpAccessProfile,
  McpCatalogAccess,
} from '@/lib/mcp/access-profile';
import { getMcpIdentity } from '@/lib/mcp/identity';
import {
  getMcpEvent,
  getMcpRecording,
  getMcpTranscript,
  listMcpLocations,
  listMcpRecorders,
  listMcpEvents,
  McpReadError,
  searchMcpTranscripts,
} from '@/lib/mcp/read-service';

vi.mock('@/lib/mcp/identity', () => ({
  getMcpIdentity: vi.fn(),
}));

vi.mock('@/lib/mcp/read-service', () => ({
  McpReadError: class McpReadError extends Error {
    readonly retryable: boolean;

    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.retryable = code === 'search_unavailable';
    }
  },
  listMcpEvents: vi.fn(),
  listMcpLocations: vi.fn(),
  listMcpRecorders: vi.fn(),
  getMcpEvent: vi.fn(),
  getMcpRecording: vi.fn(),
  getMcpTranscript: vi.fn(),
  searchMcpTranscripts: vi.fn(),
}));

vi.mock('@/lib/mcp/usage', () => ({
  trackMcpToolInvocation: vi.fn(
    async (
      _context: unknown,
      _toolName: string,
      _input: unknown,
      operation: () => unknown,
    ) => operation(),
  ),
}));

const envelope = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': {
    name: 'mcp-server-test',
    version: '1.0.0',
  },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const defaultConnection = {
  clientId: 'client-1',
  clientName: 'Test MCP client',
  scopes: ['openid', 'profile', 'email', 'besedy:read'],
};

const activeProfileFields = {
  userStatus: 'ACTIVE',
  systemRole: 'USER',
} as const;

let accessProfile: McpAccessProfile;

async function invokeMcp(
  method: string,
  params: Record<string, unknown> = {},
  connection = defaultConnection,
) {
  const handler = createMcpHandler(
    () =>
      createBesedyMcpServer({
        ...connection,
        accessProfile,
      }),
    {
      legacy: 'reject',
      responseMode: 'json',
    },
  );
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
  catalogGrant: 'LISTENER' | 'VIEWER',
  isEffectiveDefault: boolean,
  capabilityOverrides: Partial<McpCatalogAccess['capabilities']> = {},
): McpCatalogAccess {
  const elevated = catalogGrant === 'VIEWER';
  return {
    id,
    label: id,
    isUserDefault: isEffectiveDefault,
    isGlobalDefault: false,
    isEffectiveDefault,
    catalogGrant,
    isCatalogAdmin: false,
    capabilities: {
      canListEvents: true,
      canGetRecordings: true,
      canViewTranscripts: elevated,
      canSearchTranscripts: elevated,
      canSeeUnreleasedEvents: elevated,
      ...capabilityOverrides,
    },
  };
}

function catalogToolCalls(catalogId: string) {
  return [
    { name: 'list_locations', arguments: { catalogId } },
    { name: 'list_recorders', arguments: { catalogId } },
    { name: 'list_events', arguments: { catalogId } },
    { name: 'get_event', arguments: { catalogId, eventId: 42 } },
    {
      name: 'get_recording',
      arguments: { catalogId, audioHash: 'a'.repeat(64) },
    },
    {
      name: 'get_transcript',
      arguments: { catalogId, audioHash: 'a'.repeat(64), mode: 'page' },
    },
    {
      name: 'search_transcripts',
      arguments: { catalogId, query: 'search phrase' },
    },
  ];
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
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: null,
      defaultCatalogSource: null,
      catalogs: [],
      aggregate: {
        canListEvents: false,
        canGetRecordings: false,
        canViewTranscripts: false,
        canSearchTranscripts: false,
      },
    };
    vi.mocked(getMcpIdentity).mockResolvedValue({
      userId: 'user-1',
      name: 'Test User',
      email: 'user@example.com',
      emailVerified: true,
      clientId: 'client-1',
      clientName: 'Test MCP client',
    });
  });

  it('reports the current account, client, scopes, and access summary', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    };

    const body = await invokeMcp('tools/call', {
      name: 'who_am_i',
      arguments: {},
    });

    expect(getMcpIdentity).toHaveBeenCalledOnce();
    expect(getMcpIdentity).toHaveBeenCalledWith('user-1', 'client-1');
    expect(body.result?.structuredContent).toEqual({
      account: {
        id: 'user-1',
        name: 'Test User',
        email: 'user@example.com',
        emailVerified: true,
        status: 'ACTIVE',
        systemRole: 'USER',
      },
      authorization: {
        clientId: 'client-1',
        clientName: 'Test MCP client',
        grantedScopes: ['openid', 'profile', 'email', 'besedy:read'],
        accessibleCatalogCount: 1,
        defaultCatalogId: 'viewer-catalog',
      },
    });
  });

  it('withholds profile fields that were not granted to the client', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: null,
      defaultCatalogSource: null,
      catalogs: [],
      aggregate: {
        canListEvents: false,
        canGetRecordings: false,
        canViewTranscripts: false,
        canSearchTranscripts: false,
      },
    };

    const body = await invokeMcp(
      'tools/call',
      { name: 'who_am_i', arguments: {} },
      {
        clientId: 'client-1',
        clientName: 'Test MCP client',
        scopes: ['besedy:read'],
      },
    );

    expect(body.result?.structuredContent).toMatchObject({
      account: {
        name: null,
        email: null,
        emailVerified: null,
        status: null,
        systemRole: null,
      },
      authorization: { grantedScopes: ['besedy:read'] },
    });
  });

  it('returns a structured error when the account no longer exists', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: null,
      defaultCatalogSource: null,
      catalogs: [],
      aggregate: {
        canListEvents: false,
        canGetRecordings: false,
        canViewTranscripts: false,
        canSearchTranscripts: false,
      },
    };
    vi.mocked(getMcpIdentity).mockResolvedValueOnce(null);

    const body = await invokeMcp('tools/call', {
      name: 'who_am_i',
      arguments: {},
    });

    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'identity_unavailable',
          message: 'The authenticated Besedy account is no longer available',
        },
      },
    });
  });

  it('returns explicit catalog authority and a structured cursor error', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'global_default',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    };

    const successBody = await invokeMcp('tools/call', {
      name: 'list_catalogs',
      arguments: {},
    });
    expect(successBody.result?.structuredContent).toMatchObject({
      catalogs: [
        {
          id: 'viewer-catalog',
          catalogGrant: 'VIEWER',
          isCatalogAdmin: false,
        },
      ],
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'global_default',
      nextCursor: null,
    });

    const errorBody = await invokeMcp('tools/call', {
      name: 'list_catalogs',
      arguments: { cursor: 'missing-catalog' },
    });
    expect(errorBody.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'invalid_cursor',
          message: 'Invalid catalog cursor',
        },
      },
    });
  });

  it('omits transcript-derived tools for a listener-only user', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'listener-catalog',
      defaultCatalogSource: 'global_default',
      catalogs: [catalog('listener-catalog', 'LISTENER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: false,
        canSearchTranscripts: false,
      },
    };

    const body = await invokeMcp('tools/list');
    const tools = body.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'who_am_i',
      'list_catalogs',
      'list_locations',
      'list_recorders',
      'list_events',
      'get_event',
      'get_recording',
    ]);
    expect(getMcpIdentity).not.toHaveBeenCalled();
  });

  it('exposes the complete read surface when any catalog permits it', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
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
    };

    const body = await invokeMcp('tools/list');
    const tools = body.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'who_am_i',
      'list_catalogs',
      'list_locations',
      'list_recorders',
      'list_events',
      'get_event',
      'get_recording',
      'get_transcript',
      'search_transcripts',
    ]);
  });

  it('describes the transcript discovery and verification workflow in tool metadata', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    };

    const body = await invokeMcp('tools/list');
    const tools = body.result?.tools as Array<{
      name: string;
      description: string;
      inputSchema: {
        properties: Record<
          string,
          {
            description?: string;
            maximum?: number;
            properties?: Record<string, { description?: string }>;
          }
        >;
      };
    }>;
    const searchTool = tools.find((tool) => tool.name === 'search_transcripts');
    const transcriptTool = tools.find((tool) => tool.name === 'get_transcript');
    const eventsTool = tools.find((tool) => tool.name === 'list_events');
    const locationsTool = tools.find((tool) => tool.name === 'list_locations');
    const recordersTool = tools.find((tool) => tool.name === 'list_recorders');

    expect(searchTool?.description).toContain('filters.eventIds');
    expect(searchTool?.description).toContain('filters.audioHashes');
    expect(searchTool?.description).toContain('get_transcript');
    expect(searchTool?.inputSchema.properties.limit.description).toContain(
      'default is 100',
    );
    expect(
      searchTool?.inputSchema.properties.contextChunks.description,
    ).toContain('candidate triage');
    expect(
      searchTool?.inputSchema.properties.maxPerRecording.description,
    ).toContain('recording/audio hash');
    expect(searchTool?.inputSchema.properties.maxPerRecording.maximum).toBe(
      100,
    );
    expect(
      searchTool?.inputSchema.properties.filters.properties?.eventIds
        ?.description,
    ).toContain('linked recordings');
    expect(searchTool?.inputSchema.properties.filters.description).toContain(
      'list_locations',
    );
    expect(locationsTool?.description).toContain('list_events');
    expect(locationsTool?.description).toContain('search_transcripts');
    expect(recordersTool?.description).toContain('search_transcripts');
    expect(transcriptTool?.description).toContain('verify important evidence');
    expect(transcriptTool?.description).toContain('complete stored transcript');
    expect(transcriptTool?.inputSchema.properties.mode.description).toContain(
      'every segment',
    );
    expect(
      transcriptTool?.inputSchema.properties.segmentOffset.description,
    ).toContain('continuation.segmentOffset');
    expect(eventsTool?.inputSchema.properties.date.description).toContain(
      'year',
    );
    expect(eventsTool?.inputSchema.properties.locationId.description).toContain(
      'location ID',
    );
    expect(eventsTool?.inputSchema.properties.order.description).toContain(
      'oldest events first',
    );
    expect(eventsTool?.inputSchema.properties.cursor.description).toContain(
      'Opaque continuation cursor',
    );
  });

  it('uses the effective default catalog when catalogId is omitted', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    };
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
      order: 'desc',
      released: undefined,
      query: undefined,
      date: undefined,
      locationId: undefined,
    });
    expect(body.result?.content).toEqual([
      { type: 'text', text: 'Listed 0 visible Besedy event(s).' },
    ]);
    expect(body.result?.structuredContent).toEqual({
      catalogId: 'viewer-catalog',
      events: [],
      nextCursor: null,
    });

    await invokeMcp('tools/call', {
      name: 'list_events',
      arguments: {
        cursor: 'event-cursor',
        order: 'asc',
        date: { year: 2026, month: 8 },
        locationId: 7,
      },
    });
    expect(listMcpEvents).toHaveBeenLastCalledWith('viewer-catalog', 'VIEWER', {
      cursor: 'event-cursor',
      limit: 25,
      order: 'asc',
      released: undefined,
      query: undefined,
      date: { year: 2026, month: 8 },
      locationId: 7,
    });
  });

  it('uses recording access for metadata lookup tools', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    };
    vi.mocked(listMcpLocations).mockResolvedValue({
      catalogId: 'viewer-catalog',
      locations: [],
      nextCursor: null,
    });
    vi.mocked(listMcpRecorders).mockResolvedValue({
      catalogId: 'viewer-catalog',
      recorders: [],
      nextCursor: null,
    });

    await invokeMcp('tools/call', {
      name: 'list_locations',
      arguments: { query: 'Prague', limit: 10 },
    });
    expect(listMcpLocations).toHaveBeenCalledWith(
      'viewer-catalog',
      'VIEWER',
      true,
      { query: 'Prague', cursor: undefined, limit: 10 },
    );

    await invokeMcp('tools/call', {
      name: 'list_recorders',
      arguments: { query: 'Petr', cursor: 'cursor' },
    });
    expect(listMcpRecorders).toHaveBeenCalledWith('viewer-catalog', 'VIEWER', {
      query: 'Petr',
      cursor: 'cursor',
      limit: 50,
    });
  });

  it('applies bounded recording pagination defaults to get_event', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    };
    vi.mocked(getMcpEvent).mockResolvedValue({
      catalogId: 'viewer-catalog',
      event: { id: 42 },
    } as Awaited<ReturnType<typeof getMcpEvent>>);

    const body = await invokeMcp('tools/call', {
      name: 'get_event',
      arguments: { eventId: 42 },
    });

    expect(body.error).toBeUndefined();
    expect(getMcpEvent).toHaveBeenCalledWith('viewer-catalog', 42, 'VIEWER', {
      offset: 0,
      limit: 25,
    });
  });

  it('applies bounded event pagination defaults to get_recording', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    };
    vi.mocked(getMcpRecording).mockResolvedValue({
      catalogId: 'viewer-catalog',
      recording: { audioHash: 'a'.repeat(64) },
      events: { items: [], totalVisible: 0, nextOffset: null },
    } as unknown as Awaited<ReturnType<typeof getMcpRecording>>);

    const body = await invokeMcp('tools/call', {
      name: 'get_recording',
      arguments: { audioHash: 'a'.repeat(64) },
    });

    expect(body.error).toBeUndefined();
    expect(getMcpRecording).toHaveBeenCalledWith(
      'user-1',
      'viewer-catalog',
      'a'.repeat(64),
      { offset: 0, limit: 25 },
    );
  });

  it('supports compact transcript defaults and explicit full mode', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    };
    vi.mocked(getMcpTranscript).mockResolvedValue({
      catalogId: 'viewer-catalog',
      audioHash: 'a'.repeat(64),
      recordingWebUrl: 'https://besedy.example/recording',
      seekWebUrl: 'https://besedy.example/recording?seek=0',
      backend: 'whisperx/model',
      language: 'cs',
      segments: {
        items: [
          {
            segmentIndex: 0,
            id: 0,
            text: 'Transcript evidence',
            startSec: 0,
            endSec: 5,
            speaker: 'SPEAKER_00',
            webUrl: 'https://besedy.example/recording?seek=0',
          },
        ],
        totalMatching: 2,
        nextOffset: 1,
      },
      continuation: { segmentOffset: 1 },
    } as unknown as Awaited<ReturnType<typeof getMcpTranscript>>);

    const body = await invokeMcp('tools/call', {
      name: 'get_transcript',
      arguments: { audioHash: 'a'.repeat(64), mode: 'page' },
    });

    expect(body.error).toBeUndefined();
    expect(body.result?.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /Transcript evidence[\s\S]*Source: https:\/\/besedy\.example\/recording\?seek=0/,
        ),
      },
    ]);
    expect(body.result?.structuredContent).toMatchObject({
      seekWebUrl: 'https://besedy.example/recording?seek=0',
      segments: {
        items: [{ webUrl: 'https://besedy.example/recording?seek=0' }],
      },
    });
    expect(getMcpTranscript).toHaveBeenCalledWith(
      'user-1',
      'viewer-catalog',
      'a'.repeat(64),
      {
        backend: undefined,
        startSec: undefined,
        endSec: undefined,
        mode: 'page',
        segmentOffset: 0,
        segmentLimit: 50,
        maxTextChars: 20_000,
      },
    );

    await invokeMcp('tools/call', {
      name: 'get_transcript',
      arguments: { audioHash: 'a'.repeat(64), mode: 'full' },
    });
    expect(getMcpTranscript).toHaveBeenLastCalledWith(
      'user-1',
      'viewer-catalog',
      'a'.repeat(64),
      {
        backend: undefined,
        startSec: undefined,
        endSec: undefined,
        mode: 'full',
      },
    );
  });

  it('applies broad transcript search defaults with surrounding context', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    };
    vi.mocked(searchMcpTranscripts).mockResolvedValue({
      catalogId: 'viewer-catalog',
      query: 'search phrase',
      retrieval: {
        mode: 'semantic',
        exhaustive: false,
        requestedLimit: 100,
        returnedCount: 1,
        maxPerRecording: 3,
      },
      results: [
        {
          rank: 1,
          recording: { title: 'Recording title' },
          match: {
            startSec: 5,
            endSec: 10,
            text: 'Search evidence',
            webUrl: 'https://besedy.example/recording?seek=5',
          },
          context: {
            startSec: 0,
            endSec: 15,
            beforeText: 'Earlier context',
            afterText: 'Later context',
          },
        },
      ],
    } as unknown as Awaited<ReturnType<typeof searchMcpTranscripts>>);

    const body = await invokeMcp('tools/call', {
      name: 'search_transcripts',
      arguments: { query: 'search phrase' },
    });

    expect(body.error).toBeUndefined();
    expect(body.result?.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /Search evidence[\s\S]*Before: Earlier context[\s\S]*After: Later context/,
        ),
      },
    ]);
    expect(searchMcpTranscripts).toHaveBeenCalledWith(
      'viewer-catalog',
      'VIEWER',
      {
        query: 'search phrase',
        limit: 100,
        contextChunks: 1,
        maxPerRecording: 3,
        filters: undefined,
      },
    );
  });

  it('still denies a transcript call against a listener catalog', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
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
    };

    const body = await invokeMcp('tools/call', {
      name: 'get_transcript',
      arguments: {
        catalogId: 'listener-catalog',
        audioHash: 'a'.repeat(64),
        mode: 'page',
      },
    });
    const structuredContent = body.result?.structuredContent as {
      error: { code: string; retryable: boolean };
    };
    expect(structuredContent.error.code).toBe('permission_denied');
    expect(structuredContent.error.retryable).toBe(false);
    expect(getMcpTranscript).not.toHaveBeenCalled();
  });

  it('does not reveal inaccessible catalogs through any catalog tool', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    };
    for (const call of catalogToolCalls('missing-catalog')) {
      const body = await invokeMcp('tools/call', call);
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: 'not_found',
            message: 'Catalog not found or inaccessible',
            retryable: false,
          },
        },
      });
    }
    expect(listMcpEvents).not.toHaveBeenCalled();
    expect(listMcpLocations).not.toHaveBeenCalled();
    expect(listMcpRecorders).not.toHaveBeenCalled();
    expect(getMcpEvent).not.toHaveBeenCalled();
    expect(getMcpRecording).not.toHaveBeenCalled();
    expect(getMcpTranscript).not.toHaveBeenCalled();
    expect(searchMcpTranscripts).not.toHaveBeenCalled();
  });

  it('checks each resolved catalog capability at invocation time', async () => {
    const deniedCatalog = catalog('denied-catalog', 'VIEWER', false, {
      canListEvents: false,
      canGetRecordings: false,
      canViewTranscripts: false,
      canSearchTranscripts: false,
    });
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [deniedCatalog, catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    };
    for (const call of catalogToolCalls('denied-catalog')) {
      const body = await invokeMcp('tools/call', call);
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: 'permission_denied', retryable: false },
        },
      });
    }
    expect(listMcpEvents).not.toHaveBeenCalled();
    expect(listMcpLocations).not.toHaveBeenCalled();
    expect(listMcpRecorders).not.toHaveBeenCalled();
    expect(getMcpEvent).not.toHaveBeenCalled();
    expect(getMcpRecording).not.toHaveBeenCalled();
    expect(getMcpTranscript).not.toHaveBeenCalled();
    expect(searchMcpTranscripts).not.toHaveBeenCalled();
  });

  it('marks transient read failures as retryable', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
      aggregate: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
      },
    };
    vi.mocked(searchMcpTranscripts).mockRejectedValue(
      new McpReadError(
        'search_unavailable',
        'Transcript search is temporarily unavailable',
      ),
    );

    const body = await invokeMcp('tools/call', {
      name: 'search_transcripts',
      arguments: { query: 'search phrase' },
    });

    expect(body.result?.structuredContent).toEqual({
      error: {
        code: 'search_unavailable',
        message: 'Transcript search is temporarily unavailable',
        retryable: true,
      },
    });
  });
});
