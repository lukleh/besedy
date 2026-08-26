import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgMock = vi.hoisted(() => {
  const client = {
    query: vi.fn().mockResolvedValue({}),
    release: vi.fn(),
  };
  return {
    client,
    connect: vi.fn().mockResolvedValue(client),
    poolOptions: vi.fn(),
  };
});

vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool(options: unknown) {
    pgMock.poolOptions(options);
    return { connect: pgMock.connect };
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
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
    pgMock.client.query.mockClear();
    pgMock.client.release.mockClear();
    pgMock.connect.mockClear();
    pgMock.poolOptions.mockClear();
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
    expect(pgMock.client.query).toHaveBeenCalledTimes(2);
    expect(pgMock.client.query.mock.calls[0]?.[0]).toContain(
      'pg_advisory_lock',
    );
    expect(pgMock.client.query.mock.calls[1]?.[0]).toContain(
      'pg_advisory_unlock',
    );
    expect(pgMock.client.query.mock.calls[0]?.[1]).toEqual(
      pgMock.client.query.mock.calls[1]?.[1],
    );
    expect(pgMock.client.query.mock.invocationCallOrder[0]).toBeLessThan(
      handler.mock.invocationCallOrder[0]!,
    );
    expect(handler.mock.invocationCallOrder[0]).toBeLessThan(
      pgMock.client.query.mock.invocationCallOrder[1]!,
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
    expect(pgMock.connect).not.toHaveBeenCalled();
  });

  it('discards the connection when lock acquisition times out', async () => {
    const lockError = new Error('canceling statement due to statement timeout');
    pgMock.client.query.mockRejectedValueOnce(lockError);
    const handler = vi.fn(async () => Response.json({ ok: true }));

    await expect(
      serializeMcpRefreshTokenGrant(tokenRequest(), handler),
    ).rejects.toBe(lockError);

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
});
