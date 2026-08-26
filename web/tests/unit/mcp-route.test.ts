import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getPortalCapability: vi.fn(),
  hasActiveMcpAuthorization: vi.fn(),
  mcpFetch: vi.fn(),
  requireMcpAuth: vi.fn(),
}));

vi.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler: vi.fn(() => ({ fetch: mocks.mcpFetch })),
}));

vi.mock('@better-auth/mcp', () => ({
  requireMcpAuth: mocks.requireMcpAuth,
}));

vi.mock('@/lib/auth', () => ({ auth: {} }));
vi.mock('@/lib/access/capabilities', () => ({
  getPortalCapability: mocks.getPortalCapability,
}));
vi.mock('@/lib/mcp/authorization', () => ({
  hasActiveMcpAuthorization: mocks.hasActiveMcpAuthorization,
}));
vi.mock('@/lib/mcp/server', () => ({
  createBesedyMcpServer: vi.fn(),
}));
vi.mock('@/lib/security/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

describe('MCP route hardening', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.APP_ENV = 'test';
    process.env.BESEDY_MCP_ENABLED = 'true';
    process.env.AUTH_URL = 'http://localhost:3001';

    mocks.checkRateLimit.mockReturnValue(true);
    mocks.getPortalCapability.mockResolvedValue({ canEnterPortal: true });
    mocks.hasActiveMcpAuthorization.mockResolvedValue(true);
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
            scope: 'besedy:read',
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
    expect(mocks.getPortalCapability).not.toHaveBeenCalled();
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
    expect(mocks.getPortalCapability).not.toHaveBeenCalled();
  });

  it('applies authenticated user and client limits before portal queries', async () => {
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
    expect(mocks.getPortalCapability).not.toHaveBeenCalled();
  });

  it('denies MCP access when the user can no longer enter Besedy', async () => {
    mocks.getPortalCapability.mockResolvedValue({ canEnterPortal: false });
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
    expect(mocks.getPortalCapability).toHaveBeenCalledWith('user-1');
    expect(mocks.mcpFetch).not.toHaveBeenCalled();
  });

  it('denies a valid JWT after its OAuth authorization is revoked', async () => {
    mocks.hasActiveMcpAuthorization.mockResolvedValue(false);
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
    expect(mocks.hasActiveMcpAuthorization).toHaveBeenCalledWith({
      clientId: 'client-1',
      resourceUrl: 'http://localhost:3001/api/mcp',
      userId: 'user-1',
    });
    expect(mocks.getPortalCapability).not.toHaveBeenCalled();
    expect(mocks.mcpFetch).not.toHaveBeenCalled();
  });

  it('forwards a currently authorized request to the MCP handler', async () => {
    const { POST } = await import('@/app/api/mcp/route');

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.hasActiveMcpAuthorization).toHaveBeenCalledWith({
      clientId: 'client-1',
      resourceUrl: 'http://localhost:3001/api/mcp',
      userId: 'user-1',
    });
    expect(mocks.getPortalCapability).toHaveBeenCalledWith('user-1');
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
          extra: { userId: 'user-1' },
        }),
      }),
    );
  });
});
