import { auth } from '@/lib/auth';
import { normalizeClaudeCodeLoopbackRequest } from '@/lib/auth/claude-code-loopback';
import { serializeMcpRefreshTokenGrant } from '@/lib/mcp/refresh-token-lock';
import { toNextJsHandler } from 'better-auth/next-js';

const handlers = toNextJsHandler(auth.handler);

export async function GET(request: Request): Promise<Response> {
  const normalizedRequest = await normalizeClaudeCodeLoopbackRequest(request);
  return handlers.GET(normalizedRequest);
}

export async function POST(request: Request): Promise<Response> {
  const normalizedRequest = await normalizeClaudeCodeLoopbackRequest(request);
  return serializeMcpRefreshTokenGrant(normalizedRequest, () =>
    handlers.POST(normalizedRequest),
  );
}
