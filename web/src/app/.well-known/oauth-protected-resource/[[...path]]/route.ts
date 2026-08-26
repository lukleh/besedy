import { auth } from '@/lib/auth';
import { isMcpEnabled } from '@/lib/mcp/config';

function disabledResponse(): Response {
  return Response.json({ error: 'Not found' }, { status: 404 });
}

export async function GET(request: Request): Promise<Response> {
  if (!isMcpEnabled()) return disabledResponse();
  return auth.handler(request);
}

export async function HEAD(request: Request): Promise<Response> {
  if (!isMcpEnabled()) return new Response(null, { status: 404 });
  return auth.handler(request);
}
