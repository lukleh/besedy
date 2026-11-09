import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/version/route';

describe('version route', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns source and web versions while caching by web version', async () => {
    vi.stubEnv('GIT_COMMIT', 'source-commit-a');
    vi.stubEnv('WEB_VERSION', 'web-v2-f8c31c685e17be44d517f776566104c8a3d1506d');
    vi.stubEnv('BUILD_TIME', '2026-08-24T01:00:00.000Z');
    vi.stubEnv('APP_ENV', 'production');

    const response = await GET(
      new NextRequest('https://besedy.test/api/version'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      commit: 'source-commit-a',
      commitShort: 'source-',
      webVersion: 'web-v2-f8c31c685e17be44d517f776566104c8a3d1506d',
      buildTime: '2026-08-24T01:00:00.000Z',
      environment: 'production',
    });
    expect(response.headers.get('ETag')).toBe('"web-v2-f8c31c685e17be44d517f776566104c8a3d1506d"');
  });

  it('returns 304 when only the source commit changed', async () => {
    vi.stubEnv('GIT_COMMIT', 'source-commit-b');
    vi.stubEnv('WEB_VERSION', 'web-v2-f8c31c685e17be44d517f776566104c8a3d1506d');

    const response = await GET(
      new NextRequest('https://besedy.test/api/version', {
        headers: { 'If-None-Match': '"web-v2-f8c31c685e17be44d517f776566104c8a3d1506d"' },
      }),
    );

    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe('"web-v2-f8c31c685e17be44d517f776566104c8a3d1506d"');
  });
});
