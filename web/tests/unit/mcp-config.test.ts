import { describe, expect, it } from 'vitest';
import {
  getMcpJwksUrl,
  getMcpResourceUrl,
  isMcpEnabled,
  MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
  MCP_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS,
} from '@/lib/mcp/config';

describe('MCP runtime configuration', () => {
  it('uses durable OAuth token and refresh-retry lifetimes', () => {
    expect(MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS).toBe(60 * 60);
    expect(MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS).toBe(60 * 60 * 24 * 365);
    expect(MCP_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS).toBe(30);
  });

  it('defaults off in production and on in development', () => {
    expect(isMcpEnabled(undefined, 'production', 'production')).toBe(false);
    expect(isMcpEnabled(undefined, 'development', 'production')).toBe(true);
    expect(isMcpEnabled(undefined, 'unexpected', 'production')).toBe(false);
  });

  it('honors explicit enablement and rejects invalid values', () => {
    expect(isMcpEnabled('true', 'production', 'production')).toBe(true);
    expect(isMcpEnabled('false', 'development', 'development')).toBe(false);
    expect(() => isMcpEnabled('yes', 'production', 'production')).toThrow(
      'BESEDY_MCP_ENABLED',
    );
  });

  it('requires an HTTPS AUTH_URL in production', () => {
    expect(() =>
      getMcpResourceUrl(undefined, 'production', 'production'),
    ).toThrow('AUTH_URL is required');
    expect(() =>
      getMcpResourceUrl(
        'http://besedy.example.com',
        'production',
        'production',
      ),
    ).toThrow('AUTH_URL must use HTTPS');
    expect(
      getMcpResourceUrl(
        'https://besedy.example.com/',
        'production',
        'production',
      ),
    ).toBe('https://besedy.example.com/api/mcp');
  });

  it('keeps the localhost fallback for non-production development', () => {
    expect(getMcpResourceUrl(undefined, 'development', 'development')).toBe(
      'http://localhost:3001/api/mcp',
    );
  });

  it('uses the public auth endpoint for JWKS unless an internal URL is set', () => {
    expect(
      getMcpJwksUrl(
        undefined,
        'https://besedy.example.com',
        'production',
        'production',
      ),
    ).toBe('https://besedy.example.com/api/auth/jwks');
    expect(
      getMcpJwksUrl(
        'http://127.0.0.1:3000/api/auth/jwks',
        'https://besedy.example.com',
        'production',
        'production',
      ),
    ).toBe('http://127.0.0.1:3000/api/auth/jwks');
  });

  it('rejects unsafe JWKS URL forms', () => {
    expect(() => getMcpJwksUrl('relative/jwks')).toThrow('absolute URL');
    expect(() => getMcpJwksUrl('file:///tmp/jwks')).toThrow('HTTP or HTTPS');
    expect(() => getMcpJwksUrl('https://user:pass@example.com/jwks')).toThrow(
      'must not include credentials',
    );
  });
});
