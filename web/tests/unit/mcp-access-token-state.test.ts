import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashMcpOAuthToken } from '@/lib/mcp/token-storage';

const mocks = vi.hoisted(() => ({
  findAccessToken: vi.fn(),
  findRefreshToken: vi.fn(),
  logError: vi.fn(),
  updateAccessTokens: vi.fn(),
  upsertAccessToken: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  default: {
    oauthAccessToken: {
      findUnique: mocks.findAccessToken,
      updateMany: mocks.updateAccessTokens,
      upsert: mocks.upsertAccessToken,
    },
    oauthRefreshToken: { findUnique: mocks.findRefreshToken },
  },
}));

vi.mock('@/lib/log/server', () => ({
  createServerLogger: () => ({ error: mocks.logError }),
}));

import {
  getActiveStoredMcpAccessToken,
  synchronizeMcpAccessTokenState,
} from '@/lib/mcp/access-token-state';

const resourceUrl = 'https://besedy.example/api/mcp';
const issuedAt = 2_000_000_000;
const expiresAt = issuedAt + 3_600;

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt' })).toString(
      'base64url',
    ),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function accessToken() {
  return jwt({
    aud: resourceUrl,
    azp: 'client-1',
    client_id: 'client-1',
    exp: expiresAt,
    iat: issuedAt,
    jti: 'access-jti-1',
    scope: 'openid profile besedy:read',
    sid: 'session-1',
    sub: 'user-1',
  });
}

function tokenRequest(): Request {
  return new Request('https://besedy.example/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code' }),
  });
}

describe('MCP stored access-token state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('AUTH_URL', 'https://besedy.example');
    mocks.findRefreshToken.mockResolvedValue({
      id: 'refresh-1',
      clientId: 'client-1',
      userId: 'user-1',
    });
    mocks.upsertAccessToken.mockResolvedValue({});
    mocks.updateAccessTokens.mockResolvedValue({ count: 1 });
  });

  it('persists an issued JWT hash and links it to the refresh family', async () => {
    const token = accessToken();
    const response = Response.json({
      access_token: token,
      refresh_token: 'refresh-token-1',
      token_type: 'Bearer',
    });

    const result = await synchronizeMcpAccessTokenState(
      tokenRequest(),
      response,
    );

    expect(result).toBe(response);
    expect(mocks.findRefreshToken).toHaveBeenCalledWith({
      where: { token: hashMcpOAuthToken('refresh-token-1') },
      select: { id: true, clientId: true, userId: true },
    });
    expect(mocks.upsertAccessToken).toHaveBeenCalledWith({
      where: { token: hashMcpOAuthToken(token) },
      update: {},
      create: {
        id: 'access-jti-1',
        token: hashMcpOAuthToken(token),
        clientId: 'client-1',
        sessionId: 'session-1',
        userId: 'user-1',
        resources: [resourceUrl],
        requestedUserInfoClaims: [],
        refreshId: 'refresh-1',
        expiresAt: new Date(expiresAt * 1_000),
        createdAt: new Date(issuedAt * 1_000),
        confirmation: undefined,
        scopes: ['openid', 'profile', 'besedy:read'],
      },
    });
  });

  it('passes an opaque access token through without touching the registry', async () => {
    const response = Response.json({
      access_token: 'opaque-token-without-resource-binding',
      refresh_token: 'refresh-token-1',
      token_type: 'Bearer',
    });

    const result = await synchronizeMcpAccessTokenState(
      tokenRequest(),
      response,
    );

    expect(result).toBe(response);
    expect(result.status).toBe(200);
    expect(mocks.findRefreshToken).not.toHaveBeenCalled();
    expect(mocks.upsertAccessToken).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('passes a JWT for another audience through unchanged', async () => {
    const response = Response.json({
      access_token: jwt({
        aud: 'https://besedy.example/api/auth/oauth2/userinfo',
        azp: 'client-1',
        client_id: 'client-1',
        exp: expiresAt,
        iat: issuedAt,
        jti: 'foreign-jti',
        scope: 'openid',
        sub: 'user-1',
      }),
      token_type: 'Bearer',
    });

    const result = await synchronizeMcpAccessTokenState(
      tokenRequest(),
      response,
    );

    expect(result).toBe(response);
    expect(mocks.upsertAccessToken).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('fails closed for an MCP JWT that lacks the persisted claims', async () => {
    const response = Response.json({
      access_token: jwt({
        aud: resourceUrl,
        client_id: 'client-1',
        exp: expiresAt,
        iat: issuedAt,
        scope: 'besedy:read',
        sub: 'user-1',
      }),
    });

    const result = await synchronizeMcpAccessTokenState(
      tokenRequest(),
      response,
    );

    expect(result.status).toBe(503);
    expect(mocks.upsertAccessToken).not.toHaveBeenCalled();
  });

  it('fails the token response closed when its refresh family is missing', async () => {
    mocks.findRefreshToken.mockResolvedValue(null);
    const response = Response.json({
      access_token: accessToken(),
      refresh_token: 'missing-refresh-token',
    });

    const result = await synchronizeMcpAccessTokenState(
      tokenRequest(),
      response,
    );

    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({
      error: 'temporarily_unavailable',
    });
    expect(mocks.upsertAccessToken).not.toHaveBeenCalled();
  });

  it('converts a verified JWT unsupported response into stored revocation', async () => {
    const token = accessToken();
    const request = new Request(
      'https://besedy.example/api/auth/oauth2/revoke',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'client-1',
          token,
          token_type_hint: 'access_token',
        }),
      },
    );
    const unsupported = Response.json(
      { error: 'unsupported_token_type' },
      { status: 400 },
    );

    const result = await synchronizeMcpAccessTokenState(request, unsupported);

    expect(result.status).toBe(200);
    expect(mocks.updateAccessTokens).toHaveBeenCalledWith({
      where: {
        token: hashMcpOAuthToken(token),
        clientId: 'client-1',
        revoked: null,
      },
      data: { revoked: expect.any(Date) },
    });
  });

  it('accepts an unexpired, unrevoked row bound to the request identity', async () => {
    mocks.findAccessToken.mockResolvedValue({
      clientId: 'client-1',
      userId: 'user-1',
      resources: [resourceUrl],
      scopes: ['profile', 'besedy:read'],
      expiresAt: new Date(Date.now() + 60_000),
      revoked: null,
    });

    await expect(
      getActiveStoredMcpAccessToken({
        accessToken: accessToken(),
        clientId: 'client-1',
        resourceUrl,
        userId: 'user-1',
      }),
    ).resolves.toEqual({ scopes: ['profile', 'besedy:read'] });
  });

  it.each([
    ['missing', null],
    [
      'expired',
      {
        clientId: 'client-1',
        userId: 'user-1',
        resources: [resourceUrl],
        scopes: ['besedy:read'],
        expiresAt: new Date(Date.now() - 1),
        revoked: null,
      },
    ],
    [
      'revoked',
      {
        clientId: 'client-1',
        userId: 'user-1',
        resources: [resourceUrl],
        scopes: ['besedy:read'],
        expiresAt: new Date(Date.now() + 60_000),
        revoked: new Date(),
      },
    ],
    [
      'wrong user',
      {
        clientId: 'client-1',
        userId: 'user-2',
        resources: [resourceUrl],
        scopes: ['besedy:read'],
        expiresAt: new Date(Date.now() + 60_000),
        revoked: null,
      },
    ],
  ])('rejects a %s stored token row', async (_name, stored) => {
    mocks.findAccessToken.mockResolvedValue(stored);

    await expect(
      getActiveStoredMcpAccessToken({
        accessToken: accessToken(),
        clientId: 'client-1',
        resourceUrl,
        userId: 'user-1',
      }),
    ).resolves.toBeNull();
  });
});
