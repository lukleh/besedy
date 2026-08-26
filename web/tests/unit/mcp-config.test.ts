import { describe, expect, it } from 'vitest';
import { getMcpResourceUrl, isMcpEnabled } from '@/lib/mcp/config';

describe('MCP runtime configuration', () => {
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
});
