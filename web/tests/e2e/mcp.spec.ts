import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { test, expect } from './helpers/base-test';
import { TEST_AUDIO_FILES } from '../../prisma/test-data';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3002';
const DATABASE_URL =
  process.env.PLAYWRIGHT_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://besedy_test:besedy_test@localhost:5434/besedy_test';
const MCP_RESOURCE = `${BASE_URL}/api/mcp`;
const MCP_PROTOCOL_VERSION = '2026-07-28';
const TRANSCRIPT_BACKEND = 'faster-whisper/large-v3@silero_vad_v6';
const MCP_FIXTURE_RECORDING = TEST_AUDIO_FILES[4];
const pool = new Pool({ connectionString: DATABASE_URL });

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface AccessTokenClaims {
  aud?: string | string[];
  iss?: string;
  scope?: string;
  sub?: string;
}

interface McpResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface McpToolResult<T> {
  isError?: boolean;
  structuredContent: T;
}

async function registerLocalTestClient(
  clientId: string,
  redirectUri: string,
): Promise<void> {
  const clientRowId = randomUUID();
  await pool.query(
    `INSERT INTO "oauthClient" (
       id, "clientId", scopes, "clientCredentialsScopes", contacts,
       "redirectUris", "postLogoutRedirectUris", "grantTypes",
       "responseTypes", "tokenEndpointAuthMethod", "requirePKCE", name,
       "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, ARRAY['besedy:read'], ARRAY[]::text[], ARRAY[]::text[],
       ARRAY[$3], ARRAY[]::text[], ARRAY['authorization_code', 'refresh_token'],
       ARRAY['code'], 'none', true, 'Besedy MCP E2E client', NOW(), NOW()
     )`,
    [clientRowId, clientId, redirectUri],
  );
  await pool.query(
    `INSERT INTO "oauthClientResource" (
       id, "clientId", "resourceId", "createdAt"
     ) VALUES ($1, $2, $3, NOW())`,
    [randomUUID(), clientId, MCP_RESOURCE],
  );
}

async function removeLocalTestClient(clientId: string): Promise<void> {
  await pool.query(`DELETE FROM "oauthClient" WHERE "clientId" = $1`, [
    clientId,
  ]);
}

test.afterAll(async () => {
  await pool.end();
});

test('@smoke MCP OAuth v2 exercises every read tool', async ({
  page,
  request,
}) => {
  const clientId = `besedy-mcp-e2e-${randomUUID()}`;
  // Keep the callback under an unauthenticated route prefix so middleware
  // does not replace the authorization response with a sign-in redirect.
  const redirectUri = `${BASE_URL}/auth/mcp-signin/test-callback`;
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');

  // CIMD deliberately rejects loopback metadata URLs. Register a public PKCE
  // client directly as test data so this remains a fully local OAuth test.
  await registerLocalTestClient(clientId, redirectUri);

  try {
    const authorizeUrl = new URL(`${BASE_URL}/api/auth/oauth2/authorize`);
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'besedy:read',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: MCP_RESOURCE,
    }).toString();

    await page.goto(authorizeUrl.toString());
    await page.getByRole('button', { name: 'Sign in with Mock OAuth' }).click();
    await page.getByRole('button', { name: 'Owner' }).click();
    await page.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL(`${redirectUri}**`);

    const callbackUrl = new URL(page.url());
    expect(callbackUrl.searchParams.get('state')).toBe(state);
    expect(callbackUrl.searchParams.get('error')).toBeNull();
    const code = callbackUrl.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenResponse = await request.post(
      `${BASE_URL}/api/auth/oauth2/token`,
      {
        form: {
          grant_type: 'authorization_code',
          client_id: clientId,
          code: code!,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource: MCP_RESOURCE,
        },
      },
    );
    expect(tokenResponse.ok()).toBe(true);
    const token = (await tokenResponse.json()) as TokenResponse;
    expect(token.token_type).toBe('Bearer');
    expect(token.scope).toContain('besedy:read');
    expect(token.access_token).toBeTruthy();
    const tokenParts = token.access_token!.split('.');
    expect(tokenParts, 'MCP access token must be a signed JWT').toHaveLength(3);
    const accessTokenClaims = JSON.parse(
      Buffer.from(tokenParts[1]!, 'base64url').toString('utf8'),
    ) as AccessTokenClaims;
    expect(accessTokenClaims).toMatchObject({
      aud: MCP_RESOURCE,
      iss: `${BASE_URL}/api/auth`,
      scope: expect.stringContaining('besedy:read'),
      sub: expect.any(String),
    });

    const envelope = {
      'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': {
        name: 'besedy-e2e',
        version: '1.0.0',
      },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const mcpHeaders = {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    };

    const toolsResponse = await request.post(MCP_RESOURCE, {
      headers: { ...mcpHeaders, 'Mcp-Method': 'tools/list' },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: envelope },
      },
    });
    const toolsResponseText = await toolsResponse.text();
    expect(toolsResponse.ok(), toolsResponseText).toBe(true);
    const toolsBody = JSON.parse(toolsResponseText) as McpResponse<{
      tools: Array<{ name: string }>;
    }>;
    expect(toolsBody.error).toBeUndefined();
    expect(toolsBody.result?.tools.map((tool) => tool.name)).toEqual([
      'list_catalogs',
      'list_events',
      'get_event',
      'get_recording',
      'get_transcript',
      'search_transcripts',
    ]);

    const catalogResponse = await request.post(MCP_RESOURCE, {
      headers: {
        ...mcpHeaders,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'list_catalogs',
      },
      data: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'list_catalogs',
          arguments: { limit: 10 },
          _meta: envelope,
        },
      },
    });
    expect(catalogResponse.ok()).toBe(true);
    const catalogBody = (await catalogResponse.json()) as McpResponse<
      McpToolResult<{
        catalogs: Array<{
          id: string;
          catalogGrant: string | null;
          isCatalogAdmin: boolean;
          isEffectiveDefault: boolean;
          capabilities: Record<string, boolean>;
        }>;
        defaultCatalogId: string;
        defaultCatalogSource: string;
        nextCursor: string | null;
      }>
    >;
    expect(catalogBody.error).toBeUndefined();
    expect(catalogBody.result?.isError).not.toBe(true);
    const result = catalogBody.result?.structuredContent;
    expect(result?.catalogs).toHaveLength(1);
    expect(result?.defaultCatalogId).toBe(result?.catalogs[0]?.id);
    expect(result?.defaultCatalogSource).toBe('global_default');
    expect(result?.nextCursor).toBeNull();
    expect(result?.catalogs[0]).toMatchObject({
      catalogGrant: 'OWNER',
      isCatalogAdmin: false,
      isEffectiveDefault: true,
      capabilities: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
        canSeeUnreleasedEvents: true,
      },
    });

    const eventsResponse = await request.post(MCP_RESOURCE, {
      headers: {
        ...mcpHeaders,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'list_events',
      },
      data: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'list_events',
          arguments: { limit: 10 },
          _meta: envelope,
        },
      },
    });
    expect(eventsResponse.ok()).toBe(true);
    const eventsBody = (await eventsResponse.json()) as McpResponse<
      McpToolResult<{
        catalogId: string;
        events: Array<{
          id: number;
          webUrl: string;
          released: boolean;
          primaryRecording: {
            audioHash: string;
            title: string;
            artist: string | null;
            durationHms: string | null;
            ready: boolean;
            published: boolean;
          } | null;
        }>;
        nextCursor: number | null;
      }>
    >;
    expect(eventsBody.error).toBeUndefined();
    expect(eventsBody.result?.isError).not.toBe(true);
    const eventResult = eventsBody.result?.structuredContent;
    expect(eventResult?.catalogId).toBe(result?.defaultCatalogId);
    expect(eventResult?.events).toHaveLength(3);
    expect(eventResult?.events.some((event) => !event.released)).toBe(true);
    const event = eventResult?.events.find(
      (candidate) =>
        candidate.primaryRecording?.audioHash === MCP_FIXTURE_RECORDING.hash,
    );
    expect(event).toBeTruthy();
    expect(event?.webUrl).toBe(
      `${BASE_URL}/catalog/${result?.defaultCatalogId}/event/${event?.id}`,
    );
    expect(Object.keys(event!.primaryRecording!).sort()).toEqual([
      'artist',
      'audioHash',
      'durationHms',
      'published',
      'ready',
      'title',
    ]);

    const eventResponse = await request.post(MCP_RESOURCE, {
      headers: {
        ...mcpHeaders,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'get_event',
      },
      data: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_event',
          arguments: { eventId: event!.id, recordingLimit: 1 },
          _meta: envelope,
        },
      },
    });
    expect(eventResponse.ok()).toBe(true);
    const eventBody = (await eventResponse.json()) as McpResponse<
      McpToolResult<{
        catalogId: string;
        event: {
          id: number;
          webUrl: string;
          recordings: {
            items: Array<{
              audioHash: string;
              webUrl: string;
              isPrimary: boolean;
              sortOrder: number;
            }>;
            totalVisible: number;
            nextOffset: number | null;
          };
        };
      }>
    >;
    expect(eventBody.error).toBeUndefined();
    expect(eventBody.result?.isError).not.toBe(true);
    expect(eventBody.result?.structuredContent.event.id).toBe(event!.id);
    expect(eventBody.result?.structuredContent.event.webUrl).toBe(
      event!.webUrl,
    );
    expect(
      eventBody.result?.structuredContent.event.recordings.items,
    ).toHaveLength(1);
    expect(
      eventBody.result?.structuredContent.event.recordings.totalVisible,
    ).toBeGreaterThan(1);
    expect(
      eventBody.result?.structuredContent.event.recordings.nextOffset,
    ).toBe(1);
    const eventRecording =
      eventBody.result?.structuredContent.event.recordings.items[0];
    expect(eventRecording?.webUrl).toBe(
      `${BASE_URL}/catalog/${result?.defaultCatalogId}/recording/${eventRecording?.audioHash}`,
    );
    expect(Object.keys(eventRecording!).sort()).toEqual([
      'artist',
      'audioHash',
      'durationHms',
      'isPrimary',
      'published',
      'ready',
      'sortOrder',
      'title',
      'webUrl',
    ]);

    const audioHash = event!.primaryRecording!.audioHash;
    expect(audioHash).toBe(MCP_FIXTURE_RECORDING.hash);
    const recordingResponse = await request.post(MCP_RESOURCE, {
      headers: {
        ...mcpHeaders,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'get_recording',
      },
      data: {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'get_recording',
          arguments: { audioHash, eventLimit: 1 },
          _meta: envelope,
        },
      },
    });
    expect(recordingResponse.ok()).toBe(true);
    const recordingBody = (await recordingResponse.json()) as McpResponse<
      McpToolResult<{
        catalogId: string;
        recording: { audioHash: string; webUrl: string };
        events: {
          items: Array<{ id: number; webUrl: string }>;
          totalVisible: number;
          nextOffset: number | null;
        };
      }>
    >;
    expect(recordingBody.error).toBeUndefined();
    expect(recordingBody.result?.isError).not.toBe(true);
    expect(recordingBody.result?.structuredContent.recording.audioHash).toBe(
      audioHash,
    );
    expect(recordingBody.result?.structuredContent.recording.webUrl).toBe(
      `${BASE_URL}/catalog/${result?.defaultCatalogId}/recording/${audioHash}`,
    );
    expect(
      recordingBody.result?.structuredContent.events.items.some(
        (linkedEvent) => linkedEvent.id === event!.id,
      ),
    ).toBe(true);
    expect(
      recordingBody.result?.structuredContent.events.items[0]?.webUrl,
    ).toBe(event!.webUrl);
    expect(
      recordingBody.result?.structuredContent.events.totalVisible,
    ).toBeGreaterThan(0);

    const transcriptResponse = await request.post(MCP_RESOURCE, {
      headers: {
        ...mcpHeaders,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'get_transcript',
      },
      data: {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'get_transcript',
          arguments: {
            audioHash,
            backend: TRANSCRIPT_BACKEND,
            limit: 1,
          },
          _meta: envelope,
        },
      },
    });
    expect(transcriptResponse.ok()).toBe(true);
    const transcriptBody = (await transcriptResponse.json()) as McpResponse<
      McpToolResult<{
        catalogId: string;
        audioHash: string;
        backend: string;
        language: string;
        segments: Array<{
          id: number;
          text: string;
          startSec: number;
          endSec: number;
          speaker: string;
        }>;
        totalMatchingSegments: number;
        nextOffset: number | null;
      }>
    >;
    expect(transcriptBody.error).toBeUndefined();
    expect(
      transcriptBody.result?.isError,
      JSON.stringify(transcriptBody),
    ).not.toBe(true);
    expect(transcriptBody.result?.structuredContent).toMatchObject({
      catalogId: result?.defaultCatalogId,
      audioHash,
      backend: TRANSCRIPT_BACKEND,
      language: 'cs',
      totalMatchingSegments: 2,
      nextOffset: 1,
      segments: [
        {
          id: 0,
          text: 'Besedy MCP transcript fixture opens the discussion.',
          startSec: 0,
          endSec: 5,
          speaker: 'SPEAKER_00',
        },
      ],
    });

    const searchResponse = await request.post(MCP_RESOURCE, {
      headers: {
        ...mcpHeaders,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'search_transcripts',
      },
      data: {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'search_transcripts',
          arguments: {
            query: 'Besedy MCP deterministic search',
            limit: 5,
            includeNeighbors: true,
          },
          _meta: envelope,
        },
      },
    });
    expect(searchResponse.ok()).toBe(true);
    const searchBody = (await searchResponse.json()) as McpResponse<
      McpToolResult<{
        catalogId: string;
        query: string;
        results: Array<{
          rank: number;
          audioHash: string;
          chunkId: string;
          text: string;
          contextText: string;
          neighbors: { before: Array<{ text: string }>; after: unknown[] };
          citation: { workflowGroupId: string; chunkVersion: string };
        }>;
      }>
    >;
    expect(searchBody.error).toBeUndefined();
    expect(searchBody.result?.isError, JSON.stringify(searchBody)).not.toBe(
      true,
    );
    expect(searchBody.result?.structuredContent).toMatchObject({
      catalogId: result?.defaultCatalogId,
      query: 'Besedy MCP deterministic search',
      results: [
        {
          rank: 1,
          audioHash,
          chunkId: 'mcp-smoke-chunk-1',
          text: 'Deterministic Besedy MCP search evidence.',
          contextText:
            'Neighbor context before the deterministic evidence.\n\nDeterministic Besedy MCP search evidence.',
          neighbors: {
            before: [
              {
                text: 'Neighbor context before the deterministic evidence.',
              },
            ],
            after: [],
          },
          citation: {
            workflowGroupId: result?.defaultCatalogId,
            chunkVersion: 'mcp-smoke-v1',
          },
        },
      ],
    });
  } finally {
    await removeLocalTestClient(clientId);
  }
});
