import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { auth } from "@/lib/auth";
import { getPortalCapability } from "@/lib/access/capabilities";
import { createBesedyMcpServer } from "@/lib/mcp/server";
import { getMcpResourceUrl, MCP_READ_SCOPE } from "@/lib/mcp/config";

export const runtime = "nodejs";

const resourceUrl = getMcpResourceUrl();

function readScopes(claims: unknown): string[] {
  if (typeof claims !== "object" || claims === null) {
    return [];
  }
  const value = (claims as Record<string, unknown>).scope;
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === "string");
  }
  return [];
}

function readBearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.replace(/^Bearer\s+/i, "");
}

function jsonRpcAccessDenied(message: string): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message },
      id: null,
    },
    { status: 403 }
  );
}

const mcpHandler = createMcpHandler(
  async ({ authInfo }) => {
    const userId = authInfo?.extra?.userId;
    if (typeof userId !== "string") {
      throw new Error("Authenticated MCP request is missing a user subject");
    }
    return createBesedyMcpServer(userId);
  },
  {
    legacy: "reject",
    responseMode: "json",
  }
);

const protectedMcpHandler = requireMcpAuth(
  auth,
  async (request, claims) => {
    const userId = claims.sub;
    if (typeof userId !== "string" || userId.length === 0) {
      return jsonRpcAccessDenied("The access token has no Besedy user subject");
    }

    const portal = await getPortalCapability(userId);
    if (!portal.canEnterPortal) {
      return jsonRpcAccessDenied("Active Besedy portal access is required");
    }

    const clientIdClaim = claims.client_id ?? claims.azp;
    const authInfo: AuthInfo = {
      token: readBearerToken(request),
      clientId:
        typeof clientIdClaim === "string" ? clientIdClaim : "unknown-client",
      scopes: readScopes(claims),
      expiresAt: claims.exp,
      resource: new URL(resourceUrl),
      extra: { userId },
    };

    return mcpHandler.fetch(request, { authInfo });
  },
  {
    resource: resourceUrl,
    requiredScopes: [MCP_READ_SCOPE],
  }
);

export async function POST(request: Request): Promise<Response> {
  return protectedMcpHandler(request);
}
