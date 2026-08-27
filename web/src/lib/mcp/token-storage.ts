import { createHash } from 'node:crypto';

export function digestMcpOAuthToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function hashMcpOAuthToken(token: string): string {
  return digestMcpOAuthToken(token).toString('base64url');
}
