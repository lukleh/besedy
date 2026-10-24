import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { jwt } from 'better-auth/plugins';
import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { describe, expect, it, vi } from 'vitest';
import { MCP_AUTH_SCOPES } from '@/lib/mcp/config';

const BASE_URL = 'https://besedy.example';
const MCP_RESOURCE = `${BASE_URL}/api/mcp`;
const CLAUDE_AI_CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

// Published by claude.ai (fetched 2026-10-24). The jwt-bearer grant is one
// Besedy does not issue; the server must ignore it rather than refuse Claude.
const CLAUDE_AI_METADATA = {
  client_id: CLAUDE_AI_CLIENT_ID,
  client_name: 'Claude',
  client_uri: 'https://claude.ai',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  grant_types: [
    'authorization_code',
    'refresh_token',
    'urn:ietf:params:oauth:grant-type:jwt-bearer',
  ],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

const MEMORY_MODELS = [
  'user',
  'session',
  'account',
  'verification',
  'jwks',
  'oauthClient',
  'oauthClientAssertion',
  'oauthClientResource',
  'oauthResource',
  'oauthConsent',
  'oauthAccessToken',
  'oauthRefreshToken',
];

function createAuth() {
  const fetchClientMetadataResource = vi.fn<ClientMetadataResourceFetch>(
    async () =>
      new Response(JSON.stringify(CLAUDE_AI_METADATA), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  const auth = betterAuth({
    baseURL: BASE_URL,
    secret: 'cimd-claude-ai-test-secret-0123456789abcdef',
    // The memory adapter needs one array per model the plugins touch.
    database: memoryAdapter(
      Object.fromEntries(MEMORY_MODELS.map((model) => [model, []])),
    ),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt(),
      mcp({
        loginPage: '/auth/mcp-signin',
        consentPage: '/auth/mcp-consent',
        resource: MCP_RESOURCE,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationRequirePKCE: true,
        resources: [
          {
            identifier: MCP_RESOURCE,
            name: 'Besedy MCP',
            allowedScopes: [...MCP_AUTH_SCOPES],
          },
        ],
        scopes: [...MCP_AUTH_SCOPES],
        allowPublicClientPrelogin: true,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    ],
  });
  return { auth, fetchClientMetadataResource };
}

describe('CIMD authorization for claude.ai', () => {
  it('accepts a metadata document that also lists an unsupported grant', async () => {
    const { auth, fetchClientMetadataResource } = createAuth();
    const authorizeUrl = new URL(`${BASE_URL}/api/auth/oauth2/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLAUDE_AI_CLIENT_ID,
      redirect_uri: CLAUDE_AI_METADATA.redirect_uris[0],
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      state: 'claude-state',
      scope: MCP_AUTH_SCOPES.join(' '),
      resource: MCP_RESOURCE,
    }).toString();

    const response = await auth.handler(new Request(authorizeUrl));

    expect(fetchClientMetadataResource).toHaveBeenCalledWith(
      CLAUDE_AI_CLIENT_ID,
      expect.anything(),
    );
    expect(response.status, await response.clone().text()).toBe(302);
    const location = new URL(response.headers.get('location') ?? '', BASE_URL);
    expect(location.pathname).toBe('/auth/mcp-signin');
  });
});
