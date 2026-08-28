import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  createBesedyMcpServer: vi.fn(),
  getActiveMcpAuthorization: vi.fn(),
  getMcpAccessProfile: vi.fn(),
  logAccessDenied: vi.fn(),
  mcpFetch: vi.fn(),
  requireMcpAuth: vi.fn(),
  resolvePortalActorContext: vi.fn(),
}));

vi.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler: vi.fn(
    (factory: (input: { authInfo?: unknown }) => unknown) => ({
      fetch: async (request: Request, options: { authInfo?: unknown }) => {
        try {
          await factory({ authInfo: options.authInfo });
        } catch {
          return Response.json(
            {
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: 1,
            },
            { status: 500 },
          );
        }
        return mocks.mcpFetch(request, options);
      },
    }),
  ),
}));

vi.mock('@better-auth/mcp', () => ({
  requireMcpAuth: mocks.requireMcpAuth,
}));

vi.mock('@/lib/auth', () => ({ auth: {} }));
vi.mock('@/lib/audit/logger', () => ({
  logAccessDenied: mocks.logAccessDenied,
}));
vi.mock('@/lib/mcp/access-profile', () => ({
  getMcpAccessProfile: mocks.getMcpAccessProfile,
}));
vi.mock('@/lib/mcp/authorization', () => ({
  getActiveMcpAuthorization: mocks.getActiveMcpAuthorization,
}));
vi.mock('@/lib/mcp/server', () => ({
  createBesedyMcpServer: mocks.createBesedyMcpServer,
}));
vi.mock('@/lib/policy/actor', () => ({
  resolvePortalActorContext: mocks.resolvePortalActorContext,
}));
vi.mock('@/lib/security/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

describe('MCP route hardening', () => {
  const activeActor = {
    userId: 'user-1',
    isAuthenticated: true,
    userStatus: 'ACTIVE',
    systemRole: 'USER',
    canEnterPortal: true,
  } as const;
  const activeAccessProfile = {
    userId: 'user-1',
    userStatus: 'ACTIVE',
    systemRole: 'USER',
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
  } as const;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.APP_ENV = 'test';
    process.env.BESEDY_MCP_ENABLED = 'true';
    process.env.AUTH_URL = 'http://localhost:3001';

    mocks.checkRateLimit.mockReturnValue(true);
    mocks.logAccessDenied.mockResolvedValue(undefined);
    mocks.getMcpAccessProfile.mockResolvedValue(activeAccessProfile);
    mocks.resolvePortalActorContext.mockResolvedValue(activeActor);
    mocks.getActiveMcpAuthorization.mockResolvedValue({
      clientName: 'Codex',
      scopes: ['profile', 'besedy:read'],
    });
    mocks.mcpFetch.mockResolvedValue(Response.json({ ok: true }));
    mocks.requireMcpAuth.mockImplementation(
      (
        _auth: unknown,
        handler: (request: Request, claims: Record<string, unknown>) => unknown,
      ) =>
        (request: Request) =>
          handler(request, {
            sub: 'user-1',
            azp: 'client-1',
            scope: 'openid profile email besedy:read',
            exp: 2_000_000_000,
          }),
    );
  });

  function request(): Request {
    return new Request('http://localhost:3001/api/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer signed-token' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
  }

  function discoveryRequest(): Request {
    return new Request('http://localhost:3001/api/mcp', {
      method: 'GET',
    });
  }

  it('returns 404 without installing auth middleware when MCP is disabled', async () => {
    process.env.BESEDY_MCP_ENABLED = 'false';
    const { POST } = await import('@/app/api/mcp/route');

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.requireMcpAuth).not.toHaveBeenCalled();
  });

  it('does not debit authenticated limits when token verification fails', async () => {
    mocks.requireMcpAuth.mockImplementation(
      () => async () =>
        Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const { POST } = await import('@/app/api/mcp/route');

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.resolvePortalActorContext).not.toHaveBeenCalled();
    expect(mocks.logAccessDenied).not.toHaveBeenCalled();
  });

  it('passes GET discovery probes through the OAuth guard', async () => {
    mocks.requireMcpAuth.mockImplementation(
      () => async () =>
        new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="http://localhost:3001/.well-known/oauth-protected-resource/api/mcp"',
          },
        }),
    );
    const { GET } = await import('@/app/api/mcp/route');

    const response = await GET(discoveryRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      'oauth-protected-resource/api/mcp',
    );
    expect(mocks.mcpFetch).not.toHaveBeenCalled();
    expect(mocks.logAccessDenied).not.toHaveBeenCalled();
  });

  it('applies the global limit after token verification', async () => {
    mocks.checkRateLimit.mockReturnValue(false);
    const { POST } = await import('@/app/api/mcp/route');

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      'mcp:authenticated:global',
      600,
      60_000,
    );
    expect(mocks.resolvePortalActorContext).not.toHaveBeenCalled();
    expect(mocks.logAccessDenied).toHaveBeenCalledWith(
      'user-1',
      'mcp',
      'request',
      { clientId: 'client-1', reason: 'rate_limited' },
    );
  });

  it('applies authenticated user and client limits before policy queries', async () => {
    mocks.checkRateLimit.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const { POST } = await import('@/app/api/mcp/route');

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(
      2,
      'mcp:user:user-1',
      120,
      60_000,
    );
    expect(mocks.resolvePortalActorContext).not.toHaveBeenCalled();
  });

  it('denies MCP access when the user can no longer enter Besedy', async () => {
    mocks.resolvePortalActorContext.mockResolvedValue({
      ...activeActor,
      userStatus: 'BLOCKED',
      canEnterPortal: false,
    });
    const { POST } = await import('@/app/api/mcp/route');

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Active Besedy portal access is required',
      },
      id: null,
    });
    expect(mocks.resolvePortalActorContext).toHaveBeenCalledWith('user-1');
    expect(mocks.getMcpAccessProfile).not.toHaveBeenCalled();
    expect(mocks.mcpFetch).not.toHaveBeenCalled();
    expect(mocks.logAccessDenied).toHaveBeenCalledWith(
      'user-1',
      'mcp',
      'request',
      { clientId: 'client-1', reason: 'portal_access_inactive' },
    );
  });

  it('denies a valid JWT after its OAuth authorization is revoked', async () => {
    mocks.getActiveMcpAuthorization.mockResolvedValue(null);
    const { POST } = await import('@/app/api/mcp/route');

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Active Besedy MCP authorization is required',
      },
      id: null,
    });
    expect(mocks.getActiveMcpAuthorization).toHaveBeenCalledWith({
      clientId: 'client-1',
      resourceUrl: 'http://localhost:3001/api/mcp',
      tokenScopes: ['openid', 'profile', 'email', 'besedy:read'],
      userId: 'user-1',
    });
    expect(mocks.resolvePortalActorContext).not.toHaveBeenCalled();
    expect(mocks.getMcpAccessProfile).not.toHaveBeenCalled();
    expect(mocks.mcpFetch).not.toHaveBeenCalled();
    expect(mocks.logAccessDenied).toHaveBeenCalledWith(
      'user-1',
      'mcp',
      'request',
      { clientId: 'client-1', reason: 'authorization_inactive' },
    );
  });

  it('normalizes access-profile failures through the MCP handler', async () => {
    mocks.getMcpAccessProfile.mockRejectedValue(new Error('database offline'));
    const { POST } = await import('@/app/api/mcp/route');

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: 1,
    });
    expect(mocks.resolvePortalActorContext).toHaveBeenCalledWith('user-1');
    expect(mocks.getMcpAccessProfile).toHaveBeenCalledWith('user-1', {
      actor: activeActor,
    });
    expect(mocks.mcpFetch).not.toHaveBeenCalled();
  });

  it('forwards a currently authorized request to the MCP handler', async () => {
    const { POST } = await import('@/app/api/mcp/route');

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.getActiveMcpAuthorization).toHaveBeenCalledWith({
      clientId: 'client-1',
      resourceUrl: 'http://localhost:3001/api/mcp',
      tokenScopes: ['openid', 'profile', 'email', 'besedy:read'],
      userId: 'user-1',
    });
    expect(mocks.resolvePortalActorContext).toHaveBeenCalledWith('user-1');
    expect(mocks.getMcpAccessProfile).toHaveBeenCalledWith('user-1', {
      actor: activeActor,
    });
    expect(mocks.requireMcpAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        jwksUrl: 'http://localhost:3001/api/auth/jwks',
        resource: 'http://localhost:3001/api/mcp',
        requiredScopes: ['besedy:read'],
      }),
    );
    expect(mocks.mcpFetch).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        authInfo: expect.objectContaining({
          clientId: 'client-1',
          extra: { actor: activeActor, clientName: 'Codex' },
          scopes: ['profile', 'besedy:read'],
        }),
      }),
    );
    expect(mocks.createBesedyMcpServer).toHaveBeenCalledWith({
      clientId: 'client-1',
      clientName: 'Codex',
      scopes: ['profile', 'besedy:read'],
      accessProfile: activeAccessProfile,
    });
  });
});
