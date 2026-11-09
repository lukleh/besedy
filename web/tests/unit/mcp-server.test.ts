import { createMcpHandler } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BESEDY_MCP_INSTRUCTIONS,
  createBesedyMcpServer,
} from '@/lib/mcp/server';
import {
  TRANSCRIPT_VERIFICATION_GUIDANCE,
  renderTranscriptVerificationHandoff,
} from '@/lib/mcp/tools/shared';
import type {
  McpAccessProfile,
} from '@/lib/mcp/access-profile';
import { getMcpIdentity } from '@/lib/mcp/identity';
import {
  findMcpTranscriptMentions,
  getMcpEvent,
  getMcpRecording,
  getMcpTranscript,
  listMcpBookmarks,
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
  listMcpBookmarks: vi.fn(),
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

const bookmarksConnection = {
  ...defaultConnection,
  scopes: [...defaultConnection.scopes, 'besedy:bookmarks'],
};

let accessProfile: McpAccessProfile;

async function invokeMcp(
  method: string,
  params: Record<string, unknown> = {},
  connection = defaultConnection,
  protocolVersion: '2026-07-28' | '2025-06-18' = '2026-07-28',
) {
  const handler = createMcpHandler(
    () =>
      createBesedyMcpServer({
        ...connection,
        accessProfile,
      }),
    {
      legacy: 'stateless',
      responseMode: 'json',
    },
  );
  const modern = protocolVersion === '2026-07-28';
  const name = typeof params.name === 'string' ? params.name : null;
  const response = await handler.fetch(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: modern ? 'application/json' : 'application/json, text/event-stream',
        'mcp-protocol-version': protocolVersion,
        ...(modern ? { 'mcp-method': method } : {}),
        ...(modern && name ? { 'mcp-name': name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: modern ? { ...params, _meta: envelope } : params,
      }),
    }),
  );
  const text = await response.text();
  await handler.close();
  const payload = response.headers.get('content-type')?.startsWith('text/event-stream')
    ? text.split('\n').find((line) => line.startsWith('data: '))!.slice(6)
    : text;
  return JSON.parse(payload) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

function archiveToolCalls() {
  return [
    { name: 'list_locations', arguments: {} },
    { name: 'list_recorders', arguments: {} },
    { name: 'list_events', arguments: {} },
    { name: 'get_event', arguments: { eventId: 42 } },
    {
      name: 'get_recording',
      arguments: { audioHash: 'a'.repeat(64) },
    },
    {
      name: 'get_transcript',
      arguments: { audioHash: 'a'.repeat(64), mode: 'page' },
    },
    {
      name: 'search_transcripts',
      arguments: { query: 'search phrase' },
    },
    {
      name: 'find_transcript_mentions',
      arguments: { query: 'exact phrase' },
    },
  ];
}

describe('MCP personalized tool surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: null,
    };
    vi.mocked(getMcpIdentity).mockResolvedValue({
      userId: 'user-1',
      name: 'Test User',
      email: 'user@example.com',
      clientId: 'client-1',
      clientName: 'Test MCP client',
    });
  });

  it('initializes a supported 2025 client and lists the current tool surface', async () => {
    const initialized = await invokeMcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'connected-client-test', version: '1.0.0' },
    }, defaultConnection, '2025-06-18');

    expect(initialized.error).toBeUndefined();
    expect(initialized.result).toMatchObject({
      protocolVersion: '2025-06-18',
      instructions: BESEDY_MCP_INSTRUCTIONS,
      capabilities: { tools: {} },
    });
    const listed = await invokeMcp('tools/list', {}, defaultConnection, '2025-06-18');
    expect(listed.error).toBeUndefined();
    const tools = listed.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'who_am_i', 'list_locations', 'list_recorders', 'list_events',
      'get_event', 'get_recording', 'get_transcript', 'search_transcripts',
      'find_transcript_mentions',
    ]);
  });

  it('exposes every tool to an active user without catalog grants', async () => {
    const body = await invokeMcp('tools/list');
    const tools = body.result?.tools as Array<{ name: string }>;

    expect(tools.map((tool) => tool.name)).toEqual([
      'who_am_i',
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
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
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
      },
      authorization: {
        clientId: 'client-1',
        clientName: 'Test MCP client',
        grantedScopes: ['openid', 'profile', 'email', 'besedy:read'],
        archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
      },
    });
    expect(body.result?.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /Account ID: user-1[\s\S]*Archive: viewer-catalog[\s\S]*Scopes: openid, profile, email, besedy:read/,
        ),
      },
    ]);
  });

  it('withholds profile fields that were not granted to the client', async () => {
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: null,
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
      },
      authorization: { grantedScopes: ['besedy:read'] },
    });
  });

  it('returns a structured error when the account no longer exists', async () => {
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: null,
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

  it('exposes every tool to a listener-only user', async () => {
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: { id: 'listener-catalog', label: 'listener-catalog' },
    };

    const body = await invokeMcp('tools/list');
    const tools = body.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'who_am_i',
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

  it('advertises the complete archive read surface with documented output shapes', async () => {
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
    };

    const body = await invokeMcp('tools/list');
    const tools = body.result?.tools as Array<{
      name: string;
      outputSchema?: { type?: string; properties?: Record<string, unknown> };
    }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'who_am_i',
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
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
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
    // Both search tools and the server instructions must carry the same
    // verification sentence; see BESEDY_MCP_INSTRUCTIONS.
    expect(lexicalTool?.description).toContain(
      TRANSCRIPT_VERIFICATION_GUIDANCE,
    );
    expect(searchTool?.description).toContain(TRANSCRIPT_VERIFICATION_GUIDANCE);
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
      TRANSCRIPT_VERIFICATION_GUIDANCE,
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
  });

  it('provides concise cross-tool instructions for clients without a skill', async () => {
    // Prepended to every client context, so it stays bounded. Raised from
    // 1,600 for the verification-widening and speaker-attribution guidance.
    expect(BESEDY_MCP_INSTRUCTIONS.length).toBeLessThan(1_800);
    expect(BESEDY_MCP_INSTRUCTIONS).toContain(
      'Tool descriptions and schemas define individual calls',
    );
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('non-exhaustive');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('transcriptRequest');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('Literal totalMatches');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('authorized indexed chunks');
    // One shared sentence so the instructions and both search tool
    // descriptions cannot drift apart on how to verify.
    expect(BESEDY_MCP_INSTRUCTIONS).toContain(TRANSCRIPT_VERIFICATION_GUIDANCE);
    expect(BESEDY_MCP_INSTRUCTIONS).toContain(
      'authoritative event IDs, dates, and locations',
    );
    expect(BESEDY_MCP_INSTRUCTIONS).toContain(
      "cover each event's primary recording",
    );
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('distinct events');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('bounded segment webUrl');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('find_transcript_mentions');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain(
      'language of the transcript wording',
    );
    expect(BESEDY_MCP_INSTRUCTIONS).toContain(
      'Begin the first reply that uses Besedy evidence with a short caution',
    );
    expect(BESEDY_MCP_INSTRUCTIONS).toContain(
      'AI interpretation of AI-generated transcripts of Besedy recordings',
    );
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('same language as that reply');
    // An unchanged transcriptRequest replays the passage the search already
    // returned, so verification only adds context when the window widens.
    expect(BESEDY_MCP_INSTRUCTIONS).toContain(
      'widen startSec and endSec, then call the tool',
    );
    // Not every recording is multi-speaker throughout; keep the claim to what
    // the corpus supports.
    expect(BESEDY_MCP_INSTRUCTIONS).toContain(
      'discussions without speaker labels',
    );
    expect(BESEDY_MCP_INSTRUCTIONS).not.toContain('multi-speaker');
    expect(BESEDY_MCP_INSTRUCTIONS).toContain('dates may be partial');
    // Corpus language is data, not code: the instructions must stay neutral.
    expect(BESEDY_MCP_INSTRUCTIONS).not.toMatch(/czech|english|german/i);

    const body = await invokeMcp('server/discover');
    expect(body.error).toBeUndefined();
    expect(body.result?.instructions).toBe(BESEDY_MCP_INSTRUCTIONS);
  });

  it('renders usable and unavailable transcript verification handoffs', () => {
    const request = {
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

  it('uses the bound archive without catalog-selection arguments', async () => {
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
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

  it('exposes bookmarks only to clients granted the bookmarks scope', async () => {
    const withoutScope = await invokeMcp('tools/list');
    expect(
      (withoutScope.result?.tools as Array<{ name: string }>).map(
        (tool) => tool.name,
      ),
    ).not.toContain('list_bookmarks');

    const denied = await invokeMcp('tools/call', {
      name: 'list_bookmarks',
      arguments: {},
    });
    expect(denied.result?.isError ?? denied.error).toBeTruthy();
    expect(listMcpBookmarks).not.toHaveBeenCalled();

    const withScope = await invokeMcp('tools/list', {}, bookmarksConnection);
    const tools = withScope.result?.tools as Array<{
      name: string;
      description?: string;
    }>;
    expect(tools.map((tool) => tool.name).at(-1)).toBe('list_bookmarks');
    expect(
      tools.find((tool) => tool.name === 'list_bookmarks')?.description,
    ).toMatch(/never cite it as what was said/);
  });

  it('lists the caller bookmarks in the bound archive', async () => {
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
    };
    const audioHash = 'a'.repeat(64);
    vi.mocked(listMcpBookmarks).mockResolvedValue({
      catalogId: 'viewer-catalog',
      bookmarks: [
        {
          id: 'bm-1',
          positionSec: 125.5,
          comment: 'Worth quoting',
          excerpt: 'Saved line',
          createdAt: '2026-10-01T10:00:00.000Z',
          updatedAt: '2026-10-01T10:00:00.000Z',
          webUrl: `https://besedy.example/catalog/viewer-catalog/recording/${audioHash}?seek=125.5`,
          recording: {
            audioHash,
            title: 'Recording title',
            webUrl: `https://besedy.example/catalog/viewer-catalog/recording/${audioHash}`,
          },
          event: {
            id: 42,
            webUrl: 'https://besedy.example/catalog/viewer-catalog/event/42',
            date: { year: 2026, month: 8, day: 26 },
            location: { id: 7, name: 'Prague' },
            isPrimary: true,
          },
          transcriptRequest: {
            audioHash,
            mode: 'page',
            startSec: 65.5,
            endSec: 185.5,
          },
        },
      ],
      nextCursor: 'next-bookmarks',
    });

    const body = await invokeMcp(
      'tools/call',
      {
        name: 'list_bookmarks',
        arguments: { query: 'quote', audioHash: audioHash.toUpperCase() },
      },
      bookmarksConnection,
    );

    expect(listMcpBookmarks).toHaveBeenCalledWith('user-1', 'viewer-catalog', {
      query: 'quote',
      audioHash,
      cursor: undefined,
      limit: 50,
    });
    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.content).toEqual([
      {
        type: 'text',
        text: [
          'Listed 1 bookmark(s).',
          `bm-1 · Recording title [125.5s] https://besedy.example/catalog/viewer-catalog/recording/${audioHash}?seek=125.5`,
          'Event: 2026-08-26 · Prague · 42',
          `Recording: ${audioHash}`,
          'User comment: Worth quoting',
          'Saved excerpt: Saved line',
          `Transcript request: {"audioHash":"${audioHash}","mode":"page","startSec":65.5,"endSec":185.5}`,
          'Next cursor: next-bookmarks',
        ].join('\n'),
      },
    ]);

    const denied = await invokeMcp(
      'tools/call',
      { name: 'list_bookmarks', arguments: { catalogId: 'other-catalog' } },
      bookmarksConnection,
    );
    expect(denied.result?.isError).toBe(true);
    expect(listMcpBookmarks).toHaveBeenCalledOnce();
  });

  it('uses recording access for metadata lookup tools', async () => {
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
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
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
    };
    vi.mocked(getMcpEvent).mockResolvedValue({
      catalogId: 'viewer-catalog',
      event: {
        id: 42,
        webUrl: 'https://besedy.example/event/42',
        title: 'Event title',
        date: { year: 2026, month: 8, day: 28 },
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
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
    };
    vi.mocked(getMcpRecording).mockResolvedValue({
      catalogId: 'viewer-catalog',
      recording: {
        audioHash: 'a'.repeat(64),
        title: 'Recording title',
        album: null,
        durationHms: '00:10:00',
        date: { year: 2026, month: 8, day: 28 },
        location: { id: 7, name: 'Prague' },
        recorder: { id: 3, name: 'Petr' },
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
          /Recording: a{64} https:\/\/besedy\.example\/recording[\s\S]*Event: 2026-08-28 · Prague · 42 https:\/\/besedy\.example\/event\/42 · primary recording[\s\S]*duration=00:10:00[\s\S]*recorder=Petr/,
        ),
      },
    ]);
  });

  it.each(['2026-07-28', '2025-06-18'] as const)(
    'supports compact transcript defaults and explicit full mode over %s', async (protocolVersion) => {
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
    };
    vi.mocked(getMcpTranscript).mockResolvedValue({
      catalogId: 'viewer-catalog',
      audioHash: 'a'.repeat(64),
      recordingWebUrl: 'https://besedy.example/recording',
      segments: {
        items: [
          {
            segmentIndex: 0,
            text: 'Transcript evidence',
            startSec: 0,
            endSec: 5,
            webUrl: 'https://besedy.example/recording?seek=0',
          },
        ],
        totalMatching: 2,
      },
      continuation: {
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
    }, defaultConnection, protocolVersion);

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
    }, defaultConnection, protocolVersion);
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
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
    };
    vi.mocked(searchMcpTranscripts).mockResolvedValue({
      catalogId: 'viewer-catalog',
      query: 'search phrase',
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
          transcriptRequest: {
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
          /ranked, non-exhaustive candidate[\s\S]*2026-08-28 · Prague[\s\S]*Event: 42[\s\S]*Recording: a{64}[\s\S]*Search evidence[\s\S]*Before: Earlier context[\s\S]*After: Later context[\s\S]*Transcript request: \{"audioHash":/,
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

  it('explains which recordings a search covered from the applied filters', async () => {
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
    };
    vi.mocked(searchMcpTranscripts).mockResolvedValue({
      catalogId: 'viewer-catalog',
      query: 'search phrase',
      results: [],
    });
    vi.mocked(findMcpTranscriptMentions).mockResolvedValue({
      catalogId: 'viewer-catalog',
      query: 'exact phrase',
      retrieval: {
        matchMode: 'all_terms',
        totalMatches: 0,
      },
      results: [],
    });

    const renderedText = async (
      name: 'search_transcripts' | 'find_transcript_mentions',
      args: Record<string, unknown>,
    ) => {
      const body = await invokeMcp('tools/call', { name, arguments: args });
      expect(body.error).toBeUndefined();
      const content = body.result?.content as Array<{ text: string }>;
      return content[0]?.text ?? '';
    };

    const byDefault = await renderedText('search_transcripts', {
      query: 'search phrase',
    });
    expect(byDefault).toContain(
      "Only each event's primary recording was searched",
    );
    expect(byDefault).toContain('filters.includeSecondaryRecordings');

    const byHash = await renderedText('search_transcripts', {
      query: 'search phrase',
      filters: { audioHashes: ['b'.repeat(64)] },
    });
    expect(byHash).toContain(
      'Only the recordings named in filters.audioHashes were searched',
    );
    expect(byHash).not.toContain('primary recording was searched');

    const withSecondary = await renderedText('find_transcript_mentions', {
      query: 'exact phrase',
      filters: { includeSecondaryRecordings: true },
    });
    expect(withSecondary).toContain('Secondary recordings were included');
    expect(withSecondary).toContain('Group results by event ID');
    expect(withSecondary).not.toContain('primary recording was searched');
  });

  it('applies symmetric lexical-search defaults and match mode', async () => {
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
    };
    vi.mocked(findMcpTranscriptMentions).mockResolvedValue({
      catalogId: 'viewer-catalog',
      query: 'exact phrase',
      retrieval: {
        matchMode: 'all_terms',
        totalMatches: 0,
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
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
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
        matchMode: 'all_terms',
        totalMatches: 0,
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

  it('rejects retired catalog-selection arguments without reading another archive', async () => {
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
    };
    for (const call of archiveToolCalls()) {
      const body = await invokeMcp('tools/call', {
        ...call,
        arguments: { ...call.arguments, catalogId: 'missing-catalog' },
      });
      expect(body.result).toMatchObject({
        isError: true,
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

  it.each(['2026-07-28', '2025-06-18'] as const)(
    'denies every archive read without archive access over %s', async (protocolVersion) => {
    for (const call of archiveToolCalls()) {
      const body = await invokeMcp('tools/call', call, defaultConnection, protocolVersion);
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: 'not_found', message: 'Archive not found or inaccessible' },
        },
      });
    }
    expect(listMcpEvents).not.toHaveBeenCalled();
    expect(getMcpRecording).not.toHaveBeenCalled();
    expect(getMcpTranscript).not.toHaveBeenCalled();
    expect(searchMcpTranscripts).not.toHaveBeenCalled();
    expect(findMcpTranscriptMentions).not.toHaveBeenCalled();
  });

  it('marks transient read failures as retryable', async () => {
    accessProfile = {
      userId: 'user-1',
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
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
      canEnterPortal: true,
      archive: { id: 'viewer-catalog', label: 'viewer-catalog' },
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
