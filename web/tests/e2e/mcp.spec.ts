import { randomBytes, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { test, expect } from './helpers/base-test';
import { TEST_AUDIO_FILES, TEST_EVENTS } from '../../prisma/test-data';
import {
  MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  MCP_AUTH_SCOPES,
} from '../../src/lib/mcp/config';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3002';
const DATABASE_URL =
  process.env.PLAYWRIGHT_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://besedy_test:besedy_test@localhost:5434/besedy_test';
const MCP_RESOURCE = `${BASE_URL}/api/mcp`;
const MCP_REQUESTED_SCOPES = MCP_AUTH_SCOPES.join(' ');
const MCP_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_MCP_PROTOCOL_VERSION = '2025-06-18';
const TRANSCRIPT_BACKEND = 'faster-whisper/large-v3@silero_vad_v6';
const MCP_FIXTURE_RECORDING = TEST_AUDIO_FILES[4];
const pool = new Pool({ connectionString: DATABASE_URL });

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

interface AccessTokenClaims {
  aud?: string | string[];
  iss?: string;
  jti?: string;
  scope?: string;
  sub?: string;
}

interface AuthorizationServerMetadata {
  client_id_metadata_document_supported?: boolean;
  code_challenge_methods_supported?: string[];
  registration_endpoint?: string;
}

interface ClientRegistrationResponse {
  client_id?: string;
  redirect_uris?: string[];
  resources?: string[];
  token_endpoint_auth_method?: string;
}

interface McpResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface McpToolResult<T> {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent: T;
}

interface McpListedEvent {
  id: number;
  webUrl: string;
  date: { year: number; month: number | null; day: number | null };
  location: { id: number; name: string };
}

function compareMcpListedEvents(
  left: McpListedEvent,
  right: McpListedEvent,
): number {
  const leftKey = [
    left.date.year,
    left.date.month ?? 13,
    left.date.day ?? 32,
    left.id,
  ];
  const rightKey = [
    right.date.year,
    right.date.month ?? 13,
    right.date.day ?? 32,
    right.id,
  ];
  for (let index = 0; index < leftKey.length; index += 1) {
    const difference = leftKey[index]! - rightKey[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
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
  // Keep the callback under an unauthenticated route prefix so middleware
  // does not replace the authorization response with a sign-in redirect.
  const redirectUri = `${BASE_URL}/auth/mcp-signin/test-callback`;
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');

  const metadataResponse = await request.get(
    `${BASE_URL}/.well-known/oauth-authorization-server/api/auth`,
  );
  expect(metadataResponse.ok()).toBe(true);
  const metadata =
    (await metadataResponse.json()) as AuthorizationServerMetadata;
  expect(metadata).toMatchObject({
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: expect.arrayContaining(['S256']),
    registration_endpoint: `${BASE_URL}/api/auth/oauth2/register`,
  });

  const registrationResponse = await request.post(
    metadata.registration_endpoint!,
    {
      // Playwright retains the locale cookie set by discovery, so Better Auth
      // correctly treats this as a browser-originated mutation and requires a
      // same-origin header. Ordinary server-side MCP clients send no cookies.
      headers: {
        Origin: BASE_URL,
        'User-Agent': 'besedy-mcp-e2e/1.0',
      },
      data: {
        application_type: 'native',
        client_name: 'Besedy MCP DCR E2E client',
        grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: [redirectUri],
        response_types: ['code'],
        scope: MCP_REQUESTED_SCOPES,
        token_endpoint_auth_method: 'none',
      },
    },
  );
  const registrationResponseText = await registrationResponse.text();
  expect(registrationResponse.status(), registrationResponseText).toBe(201);
  const registration = JSON.parse(
    registrationResponseText,
  ) as ClientRegistrationResponse;
  expect(registration).toMatchObject({
    client_id: expect.any(String),
    redirect_uris: [redirectUri],
    resources: expect.arrayContaining([MCP_RESOURCE]),
    token_endpoint_auth_method: 'none',
  });
  const clientId = registration.client_id;
  if (!clientId) {
    throw new Error('DCR response is missing client_id');
  }

  try {
    const authorizeUrl = new URL(`${BASE_URL}/api/auth/oauth2/authorize`);
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: MCP_REQUESTED_SCOPES,
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
        headers: { Origin: BASE_URL },
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
    const tokenResponseText = await tokenResponse.text();
    expect(tokenResponse.ok(), tokenResponseText).toBe(true);
    const token = JSON.parse(tokenResponseText) as TokenResponse;
    expect(token.token_type).toBe('Bearer');
    expect(token.scope).toContain('besedy:read');
    expect(token.access_token).toBeTruthy();
    expect(token.refresh_token).toBeTruthy();
    expect(token.expires_in).toBe(MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS);

    const refresh = () =>
      request.post(`${BASE_URL}/api/auth/oauth2/token`, {
        headers: { Origin: BASE_URL },
        form: {
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: token.refresh_token!,
          resource: MCP_RESOURCE,
        },
      });
    const [firstRefreshResponse, retryRefreshResponse] = await Promise.all([
      refresh(),
      refresh(),
    ]);
    const firstRefreshText = await firstRefreshResponse.text();
    const retryRefreshText = await retryRefreshResponse.text();
    expect(firstRefreshResponse.ok(), firstRefreshText).toBe(true);
    expect(retryRefreshResponse.ok(), retryRefreshText).toBe(true);

    const refreshedToken = JSON.parse(firstRefreshText) as TokenResponse;
    const retriedToken = JSON.parse(retryRefreshText) as TokenResponse;
    expect(refreshedToken).toMatchObject({
      token_type: 'Bearer',
      access_token: expect.any(String),
      refresh_token: expect.any(String),
    });
    expect(retriedToken).toMatchObject({
      token_type: refreshedToken.token_type,
      scope: refreshedToken.scope,
      access_token: refreshedToken.access_token,
      refresh_token: refreshedToken.refresh_token,
    });
    for (const expiresIn of [
      refreshedToken.expires_in,
      retriedToken.expires_in,
    ]) {
      expect(expiresIn).toBeGreaterThanOrEqual(
        MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS - 2,
      );
      expect(expiresIn).toBeLessThanOrEqual(
        MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      );
    }
    token.access_token = refreshedToken.access_token;
    token.refresh_token = refreshedToken.refresh_token;

    const tokenParts = token.access_token!.split('.');
    expect(tokenParts, 'MCP access token must be a signed JWT').toHaveLength(3);
    const accessTokenClaims = JSON.parse(
      Buffer.from(tokenParts[1]!, 'base64url').toString('utf8'),
    ) as AccessTokenClaims;
    expect(
      Array.isArray(accessTokenClaims.aud)
        ? accessTokenClaims.aud
        : [accessTokenClaims.aud],
    ).toContain(MCP_RESOURCE);
    expect(accessTokenClaims).toMatchObject({
      iss: `${BASE_URL}/api/auth`,
      jti: expect.any(String),
      scope: expect.stringContaining('besedy:read'),
      sub: expect.any(String),
    });
    const storedAccessToken = await pool.query<{
      id: string;
      refreshId: string | null;
      revoked: Date | null;
    }>(
      `SELECT "id", "refreshId", "revoked"
       FROM "oauthAccessToken"
       WHERE "token" = $1`,
      [
        createHash('sha256')
          .update(token.access_token!)
          .digest('base64url'),
      ],
    );
    expect(storedAccessToken.rows).toEqual([
      {
        id: accessTokenClaims.jti,
        refreshId: expect.any(String),
        revoked: null,
      },
    ]);

    const legacyHeaders = {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    await pool.query(
      `UPDATE "oauthClient" SET "disabled" = TRUE WHERE "clientId" = $1`,
      [clientId],
    );
    try {
      const revokedClientResponse = await request.post(MCP_RESOURCE, {
        headers: legacyHeaders,
        data: {
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/list',
          params: {},
        },
      });
      expect(revokedClientResponse.status()).toBe(403);
      expect(await revokedClientResponse.json()).toMatchObject({
        error: { message: 'Active Besedy MCP authorization is required' },
      });
    } finally {
      await pool.query(
        `UPDATE "oauthClient" SET "disabled" = FALSE WHERE "clientId" = $1`,
        [clientId],
      );
    }

    const legacyInitializeResponse = await request.post(MCP_RESOURCE, {
      headers: legacyHeaders,
      data: {
        jsonrpc: '2.0',
        id: 100,
        method: 'initialize',
        params: {
          protocolVersion: LEGACY_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'besedy-legacy-e2e', version: '1.0.0' },
        },
      },
    });
    const legacyInitializeText = await legacyInitializeResponse.text();
    expect(legacyInitializeResponse.ok(), legacyInitializeText).toBe(true);
    expect(legacyInitializeText).toContain(
      `\"protocolVersion\":\"${LEGACY_MCP_PROTOCOL_VERSION}\"`,
    );

    const legacyToolsResponse = await request.post(MCP_RESOURCE, {
      headers: {
        ...legacyHeaders,
        'MCP-Protocol-Version': LEGACY_MCP_PROTOCOL_VERSION,
      },
      data: {
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/list',
        params: {},
      },
    });
    const legacyToolsText = await legacyToolsResponse.text();
    expect(legacyToolsResponse.ok(), legacyToolsText).toBe(true);
    for (const toolName of [
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
    ]) {
      expect(legacyToolsText).toContain(`\"name\":\"${toolName}\"`);
    }

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

    const identityResponse = await request.post(MCP_RESOURCE, {
      headers: {
        ...mcpHeaders,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'who_am_i',
      },
      data: {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'who_am_i',
          arguments: {},
          _meta: envelope,
        },
      },
    });
    const identityResponseText = await identityResponse.text();
    expect(identityResponse.ok(), identityResponseText).toBe(true);
    const identityBody = JSON.parse(identityResponseText) as McpResponse<
      McpToolResult<Record<string, unknown>>
    >;
    expect(identityBody.result?.structuredContent).toMatchObject({
      account: {
        id: expect.any(String),
        name: 'Catalog Owner',
        email: 'owner@besedy.test',
        status: 'ACTIVE',
        systemRole: 'USER',
      },
      authorization: {
        clientId,
        clientName: 'Besedy MCP DCR E2E client',
        grantedScopes: expect.arrayContaining([
          'profile',
          'email',
          'besedy:read',
        ]),
      },
    });

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
          isDefault: boolean;
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
      isDefault: true,
    });

    for (const lookup of [
      { tool: 'list_locations', field: 'locations' },
      { tool: 'list_recorders', field: 'recorders' },
    ] as const) {
      const lookupResponse = await request.post(MCP_RESOURCE, {
        headers: {
          ...mcpHeaders,
          'Mcp-Method': 'tools/call',
          'Mcp-Name': lookup.tool,
        },
        data: {
          jsonrpc: '2.0',
          id: lookup.tool === 'list_locations' ? 20 : 21,
          method: 'tools/call',
          params: {
            name: lookup.tool,
            arguments: { limit: 10 },
            _meta: envelope,
          },
        },
      });
      expect(lookupResponse.ok()).toBe(true);
      const lookupBody = (await lookupResponse.json()) as McpResponse<
        McpToolResult<{
          catalogId: string;
          locations?: Array<{ id: number; name: string }>;
          recorders?: Array<{ id: number; name: string }>;
          nextCursor: string | null;
        }>
      >;
      expect(lookupBody.error).toBeUndefined();
      expect(lookupBody.result?.isError).not.toBe(true);
      const lookupResult = lookupBody.result?.structuredContent;
      expect(lookupResult?.catalogId).toBe(result?.defaultCatalogId);
      expect(lookupResult?.[lookup.field]?.length).toBeGreaterThan(0);
    }

    const expectedEvents = TEST_EVENTS.filter(
      (event) => event.dateYear === 2024 && event.released,
    );
    const listedEvents: McpListedEvent[] = [];
    let eventCursor: string | undefined;
    let eventPagesExhausted = false;
    for (
      let pageIndex = 0;
      pageIndex <= expectedEvents.length;
      pageIndex += 1
    ) {
      const eventsResponse = await request.post(MCP_RESOURCE, {
        headers: {
          ...mcpHeaders,
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'list_events',
        },
        data: {
          jsonrpc: '2.0',
          id: 30 + pageIndex,
          method: 'tools/call',
          params: {
            name: 'list_events',
            arguments: {
              limit: 1,
              order: 'asc',
              date: { year: 2024 },
              ...(eventCursor ? { cursor: eventCursor } : {}),
            },
            _meta: envelope,
          },
        },
      });
      expect(eventsResponse.ok()).toBe(true);
      const eventsBody = (await eventsResponse.json()) as McpResponse<
        McpToolResult<{
          catalogId: string;
          events: McpListedEvent[];
          nextCursor: string | null;
        }>
      >;
      expect(eventsBody.error).toBeUndefined();
      expect(eventsBody.result?.isError).not.toBe(true);
      const eventPage = eventsBody.result?.structuredContent;
      expect(eventPage?.catalogId).toBe(result?.defaultCatalogId);
      expect(eventPage?.events).toHaveLength(1);
      listedEvents.push(...eventPage!.events);
      if (eventPage!.nextCursor === null) {
        eventPagesExhausted = true;
        break;
      }
      eventCursor = eventPage!.nextCursor;
    }

    expect(eventPagesExhausted).toBe(true);
    expect(listedEvents).toHaveLength(expectedEvents.length);
    expect(new Set(listedEvents.map((event) => event.id)).size).toBe(
      listedEvents.length,
    );
    expect(listedEvents).toEqual(
      [...listedEvents].sort(compareMcpListedEvents),
    );
    const event = listedEvents.find(
      (candidate) =>
        candidate.date.year === 2024 &&
        candidate.date.month === 3 &&
        candidate.date.day === 15 &&
        candidate.location.name === 'Location X',
    );
    expect(event).toBeTruthy();
    expect(event?.webUrl).toBe(
      `${BASE_URL}/catalog/${result?.defaultCatalogId}/event/${event?.id}`,
    );
    expect(Object.keys(event!).sort()).toEqual([
      'date',
      'id',
      'location',
      'webUrl',
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
          arguments: { eventId: event!.id, recordingLimit: 100 },
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
    ).toHaveLength(2);
    expect(
      eventBody.result?.structuredContent.event.recordings.totalVisible,
    ).toBeGreaterThan(1);
    expect(
      eventBody.result?.structuredContent.event.recordings.nextOffset,
    ).toBeNull();
    const eventRecording =
      eventBody.result?.structuredContent.event.recordings.items[0];
    expect(eventRecording?.webUrl).toBe(
      `${BASE_URL}/catalog/${result?.defaultCatalogId}/recording/${eventRecording?.audioHash}`,
    );
    expect(Object.keys(eventRecording!).sort()).toEqual([
      'audioHash',
      'isPrimary',
      'webUrl',
    ]);

    const primaryRecording =
      eventBody.result?.structuredContent.event.recordings.items.find(
        (recording) => recording.isPrimary,
      );
    const audioHash = primaryRecording!.audioHash;
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
          arguments: { audioHash },
          _meta: envelope,
        },
      },
    });
    expect(recordingResponse.ok()).toBe(true);
    const recordingBody = (await recordingResponse.json()) as McpResponse<
      McpToolResult<{
        catalogId: string;
        recording: { audioHash: string; webUrl: string };
        event: { id: number; webUrl: string } | null;
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
    expect(recordingBody.result?.structuredContent.event?.id).toBe(event!.id);
    expect(recordingBody.result?.structuredContent.event?.webUrl).toBe(
      event!.webUrl,
    );
    expect(recordingBody.result?.structuredContent.event).toMatchObject({
      date: event!.date,
      location: event!.location,
    });
    expect(
      recordingBody.result?.structuredContent.recording,
    ).not.toHaveProperty('ready');
    expect(
      recordingBody.result?.structuredContent.recording,
    ).not.toHaveProperty('published');

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
            mode: 'full',
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
        recordingWebUrl: string;
        backend: string;
        language: string;
        segments: {
          items: Array<{
            segmentIndex: number;
            id: number;
            text: string;
            startSec: number;
            endSec: number;
            speaker: string;
            webUrl: string;
          }>;
          totalMatching: number;
        };
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
      recordingWebUrl: `${BASE_URL}/catalog/${result?.defaultCatalogId}/recording/${audioHash}`,
      backend: TRANSCRIPT_BACKEND,
      language: 'cs',
      segments: {
        totalMatching: 2,
      },
    });
    expect(
      transcriptBody.result?.structuredContent.segments.items,
    ).toHaveLength(2);
    expect(transcriptBody.result?.structuredContent.segments.items[0]).toEqual({
      segmentIndex: 0,
      id: 0,
      text: 'Besedy MCP transcript fixture opens the discussion.',
      startSec: 0,
      endSec: 5,
      speaker: 'SPEAKER_00',
      webUrl: `${BASE_URL}/catalog/${result?.defaultCatalogId}/recording/${audioHash}?seek=0&end=5`,
    });
    expect(transcriptBody.result?.content?.[0]?.text).toContain(
      'Besedy MCP transcript fixture opens the discussion.',
    );

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
            contextChunks: 1,
            maxPerRecording: 2,
            filters: { eventIds: [event!.id] },
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
        retrieval: {
          mode: string;
          exhaustive: boolean;
          maxPerRecording: number;
        };
        results: Array<{
          rank: number;
          event: {
            id: number;
            webUrl: string;
            date: { year: number; month: number | null; day: number | null };
            location: { id: number; name: string };
          };
          recording: { audioHash: string };
          match: { chunkId: string; text: string; webUrl: string };
          context: { beforeText: string | null; afterText: string | null };
          citation: { workflowGroupId: string; chunkVersion: string };
          transcriptRequest: {
            audioHash: string;
            backend: string;
            mode: 'page';
            startSec: number;
            endSec: number;
          };
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
      retrieval: {
        mode: 'semantic',
        exhaustive: false,
        maxPerRecording: 2,
      },
      results: [
        {
          rank: 1,
          event: {
            id: event!.id,
            webUrl: event!.webUrl,
            date: event!.date,
            location: event!.location,
          },
          recording: {
            audioHash,
          },
          match: {
            chunkId: 'mcp-smoke-chunk-1',
            text: 'Deterministic Besedy MCP search evidence.',
            webUrl: `${BASE_URL}/catalog/${result?.defaultCatalogId}/recording/${audioHash}?seek=5&end=10`,
          },
          context: {
            beforeText: 'Neighbor context before the deterministic evidence.',
            afterText: null,
          },
          citation: {
            workflowGroupId: result?.defaultCatalogId,
            chunkVersion: 'mcp-smoke-v1',
          },
          transcriptRequest: {
            audioHash,
            backend: TRANSCRIPT_BACKEND,
            mode: 'page',
            startSec: 0,
            endSec: 10,
          },
        },
      ],
    });
    expect(searchBody.result?.content?.[0]?.text).toContain(
      'Deterministic Besedy MCP search evidence.',
    );
    expect(searchBody.result?.content?.[0]?.text).toContain(
      'ranked, non-exhaustive candidate',
    );
    expect(searchBody.result?.content?.[0]?.text).toContain(
      event!.location.name,
    );
    expect(searchBody.result?.content?.[0]?.text).toContain(
      `Event: ${event!.id} ${event!.webUrl}`,
    );
    expect(searchBody.result?.content?.[0]?.text).toContain(
      `Recording: ${audioHash}`,
    );
    expect(searchBody.result?.content?.[0]?.text).toContain(
      'Transcript request:',
    );
    expect(searchBody.result?.structuredContent.results[0]).not.toHaveProperty(
      'score',
    );
    expect(
      Object.keys(searchBody.result!.structuredContent.results[0]!.recording),
    ).toEqual(['audioHash']);

    const lexicalResponse = await request.post(MCP_RESOURCE, {
      headers: {
        ...mcpHeaders,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'find_transcript_mentions',
      },
      data: {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'find_transcript_mentions',
          arguments: {
            query: 'deterministic evidence',
            matchMode: 'phrase',
            limit: 5,
            contextChunks: 1,
            maxPerRecording: 2,
            filters: { eventIds: [event!.id] },
          },
          _meta: envelope,
        },
      },
    });
    expect(lexicalResponse.ok()).toBe(true);
    const lexicalBody = (await lexicalResponse.json()) as McpResponse<
      McpToolResult<{
        retrieval: {
          mode: string;
          matchMode: string;
          corpusCoverage: string;
          totalMatches: number;
        };
        results: Array<{
          event: {
            id: number;
            date: { year: number; month: number | null; day: number | null };
            location: { id: number; name: string };
          };
          recording: { audioHash: string };
          match: { chunkId: string };
          score?: number;
        }>;
      }>
    >;
    expect(lexicalBody.error).toBeUndefined();
    expect(lexicalBody.result?.structuredContent).toMatchObject({
      retrieval: {
        mode: 'lexical',
        matchMode: 'phrase',
        corpusCoverage: 'complete',
        totalMatches: 1,
      },
      results: [
        {
          event: {
            id: event!.id,
            date: event!.date,
            location: event!.location,
          },
          recording: { audioHash },
          match: { chunkId: 'mcp-smoke-chunk-1' },
        },
      ],
    });
    expect(lexicalBody.result?.content?.[0]?.text).toContain(
      'complete count is a chunk-match count, not a distinct-event count',
    );
    expect(lexicalBody.result?.content?.[0]?.text).toContain(
      'backend variants outside the active index',
    );
    expect(lexicalBody.result?.content?.[0]?.text).toContain(
      'Transcript request:',
    );
    expect(lexicalBody.result?.structuredContent.results[0]).not.toHaveProperty(
      'score',
    );

    const revocationResponse = await request.post(
      `${BASE_URL}/api/auth/oauth2/revoke`,
      {
        headers: { Origin: BASE_URL },
        form: {
          client_id: clientId,
          token: token.access_token!,
          token_type_hint: 'access_token',
        },
      },
    );
    expect(revocationResponse.ok(), await revocationResponse.text()).toBe(true);

    const revokedTokenResponse = await request.post(MCP_RESOURCE, {
      headers: { ...mcpHeaders, 'Mcp-Method': 'tools/list' },
      data: {
        jsonrpc: '2.0',
        id: 200,
        method: 'tools/list',
        params: { _meta: envelope },
      },
    });
    expect(revokedTokenResponse.status()).toBe(401);
    expect(revokedTokenResponse.headers()['www-authenticate']).toContain(
      'error="invalid_token"',
    );
    expect(await revokedTokenResponse.json()).toMatchObject({
      error: { message: 'The access token is inactive' },
    });
  } finally {
    await removeLocalTestClient(clientId);
  }
});
