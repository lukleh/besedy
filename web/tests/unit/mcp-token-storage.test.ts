import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  digestMcpOAuthToken,
  hashMcpOAuthToken,
} from '@/lib/mcp/token-storage';

describe('MCP OAuth token storage', () => {
  it('uses the unpadded base64url SHA-256 format persisted by Better Auth', () => {
    const token = 'test-refresh-token';
    const expected = createHash('sha256').update(token).digest();

    expect(digestMcpOAuthToken(token)).toEqual(expected);
    expect(hashMcpOAuthToken(token)).toBe(expected.toString('base64url'));
  });
});
