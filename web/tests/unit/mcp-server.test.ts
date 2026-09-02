import { createMcpHandler } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BESEDY_MCP_INSTRUCTIONS,
  createBesedyMcpServer,
  paginateCatalogs,
} from '@/lib/mcp/server';
import { renderTranscriptVerificationHandoff } from '@/lib/mcp/tools/shared';
import type {
  McpAccessProfile,
  McpCatalogAccess,
} from '@/lib/mcp/access-profile';
import { getMcpIdentity } from '@/lib/mcp/identity';
import {
  findMcpTranscriptMentions,
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
  findMcpTranscriptMentions: vi.fn(),
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
  isDefault: boolean,
): McpCatalogAccess {
  return {
    id,
    label: id,
    isDefault,
    catalogGrant,
    isCatalogAdmin: false,
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
    {
      name: 'find_transcript_mentions',
      arguments: { catalogId, query: 'exact phrase' },
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

  it('exposes every tool to an active user without catalog grants', async () => {
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
      'find_transcript_mentions',
    ]);
  });

  it('reports the current account, client, scopes, and access summary', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
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
    expect(body.result?.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /Account ID: user-1[\s\S]*Default catalog: viewer-catalog[\s\S]*Scopes: openid, profile, email, besedy:read/,
        ),
      },
    ]);
  });

  it('withholds profile fields that were not granted to the client', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: null,
      defaultCatalogSource: null,
      catalogs: [],
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
    };

    const successBody = await invokeMcp('tools/call', {
      name: 'list_catalogs',
      arguments: {},
    });
    expect(successBody.result?.structuredContent).toEqual({
      catalogs: [
        {
          id: 'viewer-catalog',
          label: 'viewer-catalog',
          isDefault: true,
          catalogGrant: 'VIEWER',
          isCatalogAdmin: false,
        },
      ],
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'global_default',
      nextCursor: null,
    });
    expect(successBody.result?.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /viewer-catalog · viewer-catalog · default · VIEWER/,
        ),
      },
    ]);

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

  it('exposes every tool to a listener-only user', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'listener-catalog',
      defaultCatalogSource: 'global_default',
      catalogs: [catalog('listener-catalog', 'LISTENER', true)],
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
      'find_transcript_mentions',
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
    };

    const body = await invokeMcp('tools/list');
    const tools = body.result?.tools as Array<{
      name: string;
      outputSchema?: { type?: string; properties?: Record<string, unknown> };
    }>;
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
      'find_transcript_mentions',
    ]);
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} output schema`).toMatchObject({
        type: 'object',
      });
      expect(
        Object.keys(tool.outputSchema?.properties ?? {}).length,
        `${tool.name} documented output fields`,
      ).toBeGreaterThan(0);
    }
  });

  it('describes the transcript discovery and verification workflow in tool metadata', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
    };

    const body = await invokeMcp('tools/list');
    const tools = body.result?.tools as Array<{
      name: string;
      description: string;
      inputSchema: {
        properties: Record<
          string,
          {
            default?: number;
            description?: string;
            maximum?: number;
            pattern?: string;
            properties?: Record<string, { description?: string }>;
          }
        >;
      };
    }>;
    const searchTool = tools.find((tool) => tool.name === 'search_transcripts');
    const lexicalTool = tools.find(
      (tool) => tool.name === 'find_transcript_mentions',
    );
    const transcriptTool = tools.find((tool) => tool.name === 'get_transcript');
    const recordingTool = tools.find((tool) => tool.name === 'get_recording');
    const identityTool = tools.find((tool) => tool.name === 'who_am_i');
    const catalogsTool = tools.find((tool) => tool.name === 'list_catalogs');
    const eventsTool = tools.find((tool) => tool.name === 'list_events');
    const locationsTool = tools.find((tool) => tool.name === 'list_locations');
    const recordersTool = tools.find((tool) => tool.name === 'list_recorders');

    expect(searchTool?.description).toContain('filters.eventIds');
    expect(lexicalTool?.description).toContain(
      'authorized indexed transcript corpus',
    );
    expect(searchTool?.description).toContain('passages by meaning');
    expect(lexicalTool?.description).toContain('search_transcripts');
    expect(lexicalTool?.description).toContain('totalMatches');
    expect(lexicalTool?.description).toContain('returned passages');
    expect(lexicalTool?.description).toContain('conceptual absence');
    expect(lexicalTool?.description).toContain('get_transcript');
    expect(lexicalTool?.inputSchema.properties.limit.default).toBe(50);
    expect(lexicalTool?.inputSchema.properties.maxPerRecording.default).toBe(
      10,
    );
    expect(lexicalTool?.inputSchema.properties.query.pattern).toBeUndefined();
    expect(searchTool?.description).toContain('filters.audioHashes');
    expect(searchTool?.description).toContain('get_transcript');
    expect(searchTool?.description).toContain('small first pass');
    expect(searchTool?.description).toContain('precise broad searches');
    expect(searchTool?.description).toContain(
      'match webUrl is a bounded citation',
    );
    expect(searchTool?.description).toContain('authoritative event ID');
    expect(searchTool?.inputSchema.properties.limit.default).toBe(50);
    expect(searchTool?.inputSchema.properties.limit.maximum).toBe(200);
    expect(searchTool?.inputSchema.properties.limit.description).toContain(
      'default is 50',
    );
    expect(searchTool?.inputSchema.properties.limit.description).toContain(
      'not as the final evidence base',
    );
    expect(
      searchTool?.inputSchema.properties.contextChunks.description,
    ).toContain('candidate triage');
    expect(
      searchTool?.inputSchema.properties.maxPerRecording.description,
    ).toContain('recording/audio hash');
    expect(searchTool?.inputSchema.properties.maxPerRecording.default).toBe(10);
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
    expect(locationsTool?.description).toContain('visible events');
    expect(locationsTool?.description).toContain('locationId');
    expect(recordersTool?.description).toContain('transcript search filters');
    expect(recordingTool?.description).toContain('event context');
    expect(recordingTool?.inputSchema.properties.eventOffset).toBeUndefined();
    expect(recordingTool?.inputSchema.properties.eventLimit).toBeUndefined();
    expect(transcriptTool?.description).toContain(
      'transcriptRequest unchanged',
    );
    expect(transcriptTool?.description).toContain('complete selected window');
    expect(transcriptTool?.description).toContain('bounded citation URL');
    expect(transcriptTool?.inputSchema.properties.backend).toBeUndefined();
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
    expect(eventsTool?.inputSchema.properties.query.description).toContain(
      'event title',
    );
    expect(eventsTool?.inputSchema.properties.released).toBeUndefined();
    expect(identityTool?.description).toContain('diagnose identity or access');
    expect(catalogsTool?.description).toContain('effective default');
  });

  it('provides concise cross-tool instructions for clients without a skill', async () => {
    expect(BESEDY_MCP_INSTRUCTIONS.length).toBeLessThan(1_600);
    expect(BESEDY_MCP_INSTRUCTIONS).toContain(
      'Tool descriptions and schemas define individual calls',
    );
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('non-exhaustive');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('transcriptRequest');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('Literal totalMatches');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('authorized indexed chunks');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('non-null transcriptRequest');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain(
      'authoritative event IDs, dates, and locations',
    );
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('same event are variants');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('distinct events');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('bounded segment webUrl');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('find_transcript_mentions');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain(
      'language of the transcript wording',
    );
    // Corpus language is data, not code: the instructions must stay neutral.
    expect(BESEDY_MCP_INSTRUCTIONS).not.toMatch(/czech|english|german/i);

    const body = await invokeMcp('server/discover');
    expect(body.error).toBeUndefined();
    expect(body.result?.instructions).toBe(BESEDY_MCP_INSTRUCTIONS);
  });

  it('renders usable and unavailable transcript verification handoffs', () => {
    const request = {
      catalogId: 'viewer-catalog',
      audioHash: 'a'.repeat(64),
      mode: 'page',
      startSec: 0,
      endSec: 15,
    };
    expect(renderTranscriptVerificationHandoff(request)).toBe(
      `Transcript request: ${JSON.stringify(request)}`,
    );
    expect(renderTranscriptVerificationHandoff(null)).toContain(
      'Transcript request unavailable',
    );
    expect(renderTranscriptVerificationHandoff(null)).toContain(
      'Do not rely on it as important evidence',
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
    };
    vi.mocked(listMcpEvents).mockResolvedValue({
      catalogId: 'viewer-catalog',
      events: [
        {
          id: 42,
          webUrl: 'https://besedy.example/event/42',
          date: { year: 2026, month: 8, day: 28 },
          location: { id: 7, name: 'Prague' },
        },
      ],
      nextCursor: 'next-events',
    });

    const body = await invokeMcp('tools/call', {
      name: 'list_events',
      arguments: {},
    });

    expect(body.error).toBeUndefined();
    expect(listMcpEvents).toHaveBeenCalledWith('viewer-catalog', {
      cursor: undefined,
      limit: 25,
      order: 'desc',
      query: undefined,
      date: undefined,
      locationId: undefined,
    });
    expect(body.result?.content).toEqual([
      {
        type: 'text',
        text: 'Listed 1 event(s).\n2026-08-28 · Prague · Event 42: https://besedy.example/event/42\nNext cursor: next-events',
      },
    ]);
    expect(body.result?.structuredContent).toEqual({
      catalogId: 'viewer-catalog',
      events: [
        {
          id: 42,
          webUrl: 'https://besedy.example/event/42',
          date: { year: 2026, month: 8, day: 28 },
          location: { id: 7, name: 'Prague' },
        },
      ],
      nextCursor: 'next-events',
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
    expect(listMcpEvents).toHaveBeenLastCalledWith('viewer-catalog', {
      cursor: 'event-cursor',
      limit: 25,
      order: 'asc',
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
    };
    vi.mocked(listMcpLocations).mockResolvedValue({
      catalogId: 'viewer-catalog',
      locations: [{ id: 7, name: 'Prague', eventCount: 2 }],
      nextCursor: 'next-locations',
    });
    vi.mocked(listMcpRecorders).mockResolvedValue({
      catalogId: 'viewer-catalog',
      recorders: [{ id: 3, name: 'Petr', recordingCount: 4 }],
      nextCursor: null,
    });

    const locationsBody = await invokeMcp('tools/call', {
      name: 'list_locations',
      arguments: { query: 'Prague', limit: 10 },
    });
    expect(listMcpLocations).toHaveBeenCalledWith('viewer-catalog', {
      query: 'Prague',
      cursor: undefined,
      limit: 10,
    });
    expect(locationsBody.result?.content).toEqual([
      {
        type: 'text',
        text: 'Listed 1 event location(s).\n7 · Prague · 2 event(s)\nNext cursor: next-locations',
      },
    ]);

    const recordersBody = await invokeMcp('tools/call', {
      name: 'list_recorders',
      arguments: { query: 'Petr', cursor: 'cursor' },
    });
    expect(listMcpRecorders).toHaveBeenCalledWith('viewer-catalog', {
      query: 'Petr',
      cursor: 'cursor',
      limit: 50,
    });
    expect(recordersBody.result?.content).toEqual([
      {
        type: 'text',
        text: 'Listed 1 recorder(s).\n3 · Petr · 4 recording(s)',
      },
    ]);
  });

  it('applies bounded recording pagination defaults to get_event', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
    };
    vi.mocked(getMcpEvent).mockResolvedValue({
      catalogId: 'viewer-catalog',
      event: {
        id: 42,
        webUrl: 'https://besedy.example/event/42',
        title: 'Event title',
        description: null,
        date: { year: 2026, month: 8, day: 28 },
        sessionIndex: 1,
        location: { id: 7, name: 'Prague' },
        recordings: {
          items: [
            {
              audioHash: 'a'.repeat(64),
              webUrl: 'https://besedy.example/recording',
              isPrimary: true,
            },
          ],
          totalVisible: 2,
          nextOffset: 1,
        },
      },
    });

    const body = await invokeMcp('tools/call', {
      name: 'get_event',
      arguments: { eventId: 42 },
    });

    expect(body.error).toBeUndefined();
    expect(body.result?.isError).not.toBe(true);
    expect(getMcpEvent).toHaveBeenCalledWith('viewer-catalog', 42, {
      offset: 0,
      limit: 25,
    });
    expect(body.result?.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /2026-08-28 · Prague · Event 42[\s\S]*Primary recording: a{64} https:\/\/besedy\.example\/recording[\s\S]*Continue with recordingOffset 1\./,
        ),
      },
    ]);
  });

  it('gets recording metadata without event pagination', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
    };
    vi.mocked(getMcpRecording).mockResolvedValue({
      catalogId: 'viewer-catalog',
      recording: {
        audioHash: 'a'.repeat(64),
        title: 'Recording title',
        artist: 'Speaker',
        album: null,
        durationHms: '00:10:00',
        sourceDate: null,
        date: { year: 2026, month: 8, day: 28 },
        location: { id: 7, name: 'Prague' },
        recorder: { id: 3, name: 'Petr' },
        verified: true,
        notes: null,
        tags: [],
        webUrl: 'https://besedy.example/recording',
      },
      event: {
        id: 42,
        webUrl: 'https://besedy.example/event/42',
        date: { year: 2026, month: 8, day: 28 },
        location: { id: 7, name: 'Prague' },
        isPrimary: true,
      },
    });

    const body = await invokeMcp('tools/call', {
      name: 'get_recording',
      arguments: { audioHash: 'A'.repeat(64) },
    });

    expect(body.error).toBeUndefined();
    expect(body.result?.isError).not.toBe(true);
    expect(getMcpRecording).toHaveBeenCalledWith(
      'viewer-catalog',
      'a'.repeat(64),
    );
    expect(body.result?.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /Recording: a{64} https:\/\/besedy\.example\/recording[\s\S]*Event: 2026-08-28 · Prague · 42 https:\/\/besedy\.example\/event\/42 · primary recording[\s\S]*artist=Speaker[\s\S]*recorder=Petr/,
        ),
      },
    ]);
  });

  it('supports compact transcript defaults and explicit full mode', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
    };
    vi.mocked(getMcpTranscript).mockResolvedValue({
      catalogId: 'viewer-catalog',
      audioHash: 'a'.repeat(64),
      recordingWebUrl: 'https://besedy.example/recording',
      durationSec: 600,
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
      },
      continuation: {
        catalogId: 'viewer-catalog',
        audioHash: 'a'.repeat(64),
        mode: 'page',
        segmentOffset: 1,
        segmentLimit: 50,
        maxTextChars: 20_000,
      },
    });

    const body = await invokeMcp('tools/call', {
      name: 'get_transcript',
      arguments: { audioHash: 'a'.repeat(64), mode: 'page' },
    });

    expect(body.error).toBeUndefined();
    expect(body.result?.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /Transcript evidence[\s\S]*Source: https:\/\/besedy\.example\/recording\?seek=0[\s\S]*Continue with segmentOffset 1\./,
        ),
      },
    ]);
    expect(body.result?.structuredContent).toMatchObject({
      segments: {
        items: [{ webUrl: 'https://besedy.example/recording?seek=0' }],
      },
    });
    expect(body.result?.structuredContent).not.toHaveProperty('backend');
    expect(body.result?.structuredContent).not.toHaveProperty(
      'availableBackends',
    );
    expect(body.result?.structuredContent).not.toHaveProperty('seekWebUrl');
    expect(getMcpTranscript).toHaveBeenCalledWith(
      'viewer-catalog',
      'a'.repeat(64),
      {
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
      'viewer-catalog',
      'a'.repeat(64),
      {
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
    };
    vi.mocked(searchMcpTranscripts).mockResolvedValue({
      catalogId: 'viewer-catalog',
      query: 'search phrase',
      retrieval: {
        mode: 'semantic',
        exhaustive: false,
        requestedLimit: 50,
        returnedCount: 1,
        maxPerRecording: 10,
      },
      results: [
        {
          rank: 1,
          event: {
            id: 42,
            webUrl: 'https://besedy.example/event/42',
            date: { year: 2026, month: 8, day: 28 },
            location: { id: 7, name: 'Prague' },
          },
          recording: {
            audioHash: 'a'.repeat(64),
          },
          match: {
            chunkId: 'chunk-1',
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
          citation: {
            audioHash: 'a'.repeat(64),
            chunkId: 'chunk-1',
            startSec: 5,
            endSec: 10,
            workflowGroupId: 'viewer-catalog',
            chunkVersion: 'v1',
          },
          transcriptRequest: {
            catalogId: 'viewer-catalog',
            audioHash: 'a'.repeat(64),
            mode: 'page',
            startSec: 0,
            endSec: 15,
          },
        },
      ],
    });

    const body = await invokeMcp('tools/call', {
      name: 'search_transcripts',
      arguments: { query: 'search phrase' },
    });

    expect(body.error).toBeUndefined();
    expect(body.result?.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /ranked, non-exhaustive candidate[\s\S]*2026-08-28 · Prague[\s\S]*Event: 42[\s\S]*Recording: a{64}[\s\S]*Search evidence[\s\S]*Before: Earlier context[\s\S]*After: Later context[\s\S]*Transcript request: \{"catalogId":"viewer-catalog"/,
        ),
      },
    ]);
    const renderedContent = body.result?.content as Array<{ text: string }>;
    const transcriptRequestLine = renderedContent[0]?.text
      .split('\n')
      .find((line) => line.startsWith('Transcript request: '));
    expect(transcriptRequestLine).toBeDefined();
    const renderedTranscriptRequest = JSON.parse(
      transcriptRequestLine!.slice('Transcript request: '.length),
    );
    const structuredContent = body.result?.structuredContent as {
      results: Array<{
        event: Record<string, unknown>;
        recording: Record<string, unknown>;
        transcriptRequest: Record<string, unknown>;
      }>;
    };
    expect(structuredContent.results[0]?.event).toEqual({
      id: 42,
      webUrl: 'https://besedy.example/event/42',
      date: { year: 2026, month: 8, day: 28 },
      location: { id: 7, name: 'Prague' },
    });
    expect(structuredContent.results[0]?.recording).toEqual({
      audioHash: 'a'.repeat(64),
    });
    expect(structuredContent.results[0]).not.toHaveProperty('metadata');
    expect(renderedTranscriptRequest).toEqual(
      structuredContent.results[0]?.transcriptRequest,
    );
    expect(searchMcpTranscripts).toHaveBeenCalledWith('viewer-catalog', {
      query: 'search phrase',
      limit: 50,
      contextChunks: 1,
      maxPerRecording: 10,
      filters: undefined,
    });
  });

  it('applies symmetric lexical-search defaults and match mode', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
    };
    vi.mocked(findMcpTranscriptMentions).mockResolvedValue({
      catalogId: 'viewer-catalog',
      query: 'exact phrase',
      retrieval: {
        mode: 'lexical',
        matchMode: 'all_terms',
        corpusCoverage: 'complete',
        totalMatches: 0,
        requestedLimit: 50,
        returnedCount: 0,
        maxPerRecording: 10,
      },
      results: [],
    });

    const body = await invokeMcp('tools/call', {
      name: 'find_transcript_mentions',
      arguments: { query: 'exact phrase' },
    });

    expect(body.error).toBeUndefined();
    expect(body.result?.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /found 0 matching indexed chunk\(s\) across the complete authorized indexed transcript corpus and returned 0[\s\S]*chunk-match count, not a distinct-event count[\s\S]*zero count establishes only indexed literal-pattern absence/,
        ),
      },
    ]);
    expect(findMcpTranscriptMentions).toHaveBeenCalledWith('viewer-catalog', {
      query: 'exact phrase',
      matchMode: 'all_terms',
      limit: 50,
      contextChunks: 1,
      maxPerRecording: 10,
      filters: undefined,
    });
  });

  it('keeps lexical query validation Unicode-aware', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
    };

    const invalidBody = await invokeMcp('tools/call', {
      name: 'find_transcript_mentions',
      arguments: { query: '!!!' },
    });

    expect(invalidBody.result).toMatchObject({ isError: true });
    expect(invalidBody.result?.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining(
          'Query must contain a searchable letter or number.',
        ),
      },
    ]);
    expect(findMcpTranscriptMentions).not.toHaveBeenCalled();

    vi.mocked(findMcpTranscriptMentions).mockResolvedValue({
      catalogId: 'viewer-catalog',
      query: 'člověk',
      retrieval: {
        mode: 'lexical',
        matchMode: 'all_terms',
        corpusCoverage: 'complete',
        totalMatches: 0,
        requestedLimit: 50,
        returnedCount: 0,
        maxPerRecording: 10,
      },
      results: [],
    });

    const validBody = await invokeMcp('tools/call', {
      name: 'find_transcript_mentions',
      arguments: { query: 'člověk' },
    });

    expect(validBody.result?.isError).not.toBe(true);
    expect(findMcpTranscriptMentions).toHaveBeenCalledWith(
      'viewer-catalog',
      expect.objectContaining({ query: 'člověk' }),
    );

    const shortPrefixBody = await invokeMcp('tools/call', {
      name: 'find_transcript_mentions',
      arguments: { query: 'a', matchMode: 'prefix' },
    });
    expect(shortPrefixBody.result).toMatchObject({ isError: true });
    expect(shortPrefixBody.result?.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining(
          'Prefix query tokens must contain at least 2 characters.',
        ),
      },
    ]);
  });

  it('does not reveal inaccessible catalogs through any catalog tool', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
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
    expect(findMcpTranscriptMentions).not.toHaveBeenCalled();
  });

  it('marks transient read failures as retryable', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
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

  it('logs unexpected read failures without returning their details', async () => {
    accessProfile = {
      userId: 'user-1',
      ...activeProfileFields,
      canEnterPortal: true,
      defaultCatalogId: 'viewer-catalog',
      defaultCatalogSource: 'user_preference',
      catalogs: [catalog('viewer-catalog', 'VIEWER', true)],
    };
    vi.mocked(getMcpRecording).mockRejectedValue(
      new Error('database host secret'),
    );

    const body = await invokeMcp('tools/call', {
      name: 'get_recording',
      arguments: { audioHash: 'a'.repeat(64) },
    });

    expect(body.result?.structuredContent).toEqual({
      error: {
        code: 'internal_error',
        message: 'The tool could not complete because of an internal error',
        retryable: true,
      },
    });
    expect(JSON.stringify(body)).not.toContain('database host secret');
  });
});
