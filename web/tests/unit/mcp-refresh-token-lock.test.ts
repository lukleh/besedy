import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  findRefreshFamily: vi.fn(),
}));

const pgMock = vi.hoisted(() => {
  const client = {
    query: vi.fn().mockResolvedValue({}),
    release: vi.fn(),
  };
  return {
    client,
    connect: vi.fn().mockResolvedValue(client),
    on: vi.fn(),
    poolOptions: vi.fn(),
  };
});

const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

vi.mock('@/lib/db', () => ({
  default: {
    oauthRefreshToken: { findUnique: dbMock.findRefreshFamily },
  },
}));

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool(options: unknown) {
    pgMock.poolOptions(options);
    return { connect: pgMock.connect, on: pgMock.on };
  }),
}));

import { serializeMcpRefreshTokenGrant } from '@/lib/mcp/refresh-token-lock';

function tokenRequest(grantType = 'refresh_token'): Request {
  return new Request('https://besedy.example/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: grantType,
      refresh_token: 'test-refresh-token',
    }),
  });
}

describe('MCP refresh token serialization', () => {
  afterAll(() => {
    consoleError.mockRestore();
  });

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
    pgMock.client.query.mockClear();
    pgMock.client.release.mockClear();
    pgMock.connect.mockClear();
    pgMock.on.mockClear();
    pgMock.poolOptions.mockClear();
    dbMock.findRefreshFamily.mockReset();
    dbMock.findRefreshFamily.mockResolvedValue({
      clientId: 'client-1',
      userId: 'user-1',
      referenceId: null,
    });
    consoleError.mockClear();
  });

  it('holds a PostgreSQL advisory lock while rotating a refresh token', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));

    const response = await serializeMcpRefreshTokenGrant(
      tokenRequest(),
      handler,
    );

    expect(response.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(pgMock.connect).toHaveBeenCalledOnce();
    expect(pgMock.poolOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 4,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 15_000,
      }),
    );
    expect(pgMock.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(pgMock.client.query).toHaveBeenCalledTimes(4);
    expect(pgMock.client.query.mock.calls[0]?.[0]).toContain(
      'pg_advisory_lock',
    );
    expect(pgMock.client.query.mock.calls[1]?.[0]).toContain(
      'pg_advisory_lock_shared',
    );
    expect(pgMock.client.query.mock.calls[2]?.[0]).toContain(
      'pg_advisory_unlock_shared',
    );
    expect(pgMock.client.query.mock.calls[3]?.[0]).toContain(
      'pg_advisory_unlock',
    );
    expect(pgMock.client.query.mock.calls[0]?.[1]).toEqual(
      pgMock.client.query.mock.calls[3]?.[1],
    );
    expect(pgMock.client.query.mock.calls[1]?.[1]).toEqual(
      pgMock.client.query.mock.calls[2]?.[1],
    );
    expect(pgMock.client.query.mock.calls[1]?.[1]).toEqual([
      'client-1',
      'user-1',
      null,
    ]);
    expect(pgMock.client.query.mock.invocationCallOrder[0]).toBeLessThan(
      handler.mock.invocationCallOrder[0]!,
    );
    expect(handler.mock.invocationCallOrder[0]).toBeLessThan(
      pgMock.client.query.mock.invocationCallOrder[2]!,
    );
    expect(pgMock.client.release).toHaveBeenCalledWith(false);
  });

  it('bypasses the lock for other OAuth grants', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));

    await serializeMcpRefreshTokenGrant(
      tokenRequest('authorization_code'),
      handler,
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(dbMock.findRefreshFamily).not.toHaveBeenCalled();
    expect(pgMock.connect).not.toHaveBeenCalled();
  });

  it('lets Better Auth reject an unknown refresh token without locking', async () => {
    dbMock.findRefreshFamily.mockResolvedValue(null);
    const handler = vi.fn(async () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    );

    const response = await serializeMcpRefreshTokenGrant(
      tokenRequest(),
      handler,
    );

    expect(response.status).toBe(400);
    expect(handler).toHaveBeenCalledOnce();
    expect(pgMock.connect).not.toHaveBeenCalled();
  });

  it('returns a retryable OAuth error when the token family lookup fails', async () => {
    const lookupError = new Error('database unavailable');
    dbMock.findRefreshFamily.mockRejectedValue(lookupError);
    const handler = vi.fn(async () => Response.json({ ok: true }));

    const response = await serializeMcpRefreshTokenGrant(
      tokenRequest(),
      handler,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.json()).resolves.toEqual({
      error: 'temporarily_unavailable',
      error_description:
        'The authorization server is temporarily unable to process the refresh grant',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(pgMock.connect).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '[mcp] Refresh grant serialization is unavailable',
      lookupError,
    );
  });

  it('returns a retryable OAuth error when the lock pool is exhausted', async () => {
    const connectError = new Error('timeout exceeded when trying to connect');
    pgMock.connect.mockRejectedValueOnce(connectError);
    const handler = vi.fn(async () => Response.json({ ok: true }));

    const response = await serializeMcpRefreshTokenGrant(
      tokenRequest(),
      handler,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(handler).not.toHaveBeenCalled();
    expect(pgMock.client.release).not.toHaveBeenCalled();
  });

  it('returns a retryable OAuth error and discards the connection when locking times out', async () => {
    const lockError = new Error('canceling statement due to statement timeout');
    pgMock.client.query.mockRejectedValueOnce(lockError);
    const handler = vi.fn(async () => Response.json({ ok: true }));

    const response = await serializeMcpRefreshTokenGrant(
      tokenRequest(),
      handler,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(handler).not.toHaveBeenCalled();
    expect(pgMock.client.release).toHaveBeenCalledWith(true);
  });

  it('recognizes the token endpoint under a different auth base path', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const request = new Request(
      'https://besedy.example/custom/auth/oauth2/token/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: 'test-refresh-token',
        }),
      },
    );

    await serializeMcpRefreshTokenGrant(request, handler);

    expect(pgMock.connect).toHaveBeenCalledOnce();
  });

  it('locks the same last duplicate form values that Better Auth processes', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const request = new Request(
      'https://besedy.example/api/auth/oauth2/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:
          'grant_type=authorization_code&refresh_token=ignored' +
          '&grant_type=refresh_token&refresh_token=processed',
      },
    );

    await serializeMcpRefreshTokenGrant(request, handler);

    const storedToken = createHash('sha256')
      .update('processed')
      .digest('base64url');
    expect(dbMock.findRefreshFamily).toHaveBeenCalledWith({
      where: { token: storedToken },
      select: { clientId: true, userId: true, referenceId: true },
    });
    const digest = createHash('sha256').update('processed').digest();
    expect(pgMock.client.query.mock.calls[0]?.[1]).toEqual([
      digest.readInt32BE(0),
      digest.readInt32BE(4),
    ]);
    expect(handler).toHaveBeenCalledOnce();
  });
});
