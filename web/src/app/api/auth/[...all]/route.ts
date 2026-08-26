import { auth } from "@/lib/auth";
import { serializeMcpRefreshTokenGrant } from "@/lib/mcp/refresh-token-lock";
import { toNextJsHandler } from "better-auth/next-js";

const handlers = toNextJsHandler(auth.handler);

export const GET = handlers.GET;

export async function POST(request: Request): Promise<Response> {
  return serializeMcpRefreshTokenGrant(request, () => handlers.POST(request));
}
