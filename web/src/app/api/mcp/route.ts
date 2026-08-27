import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { requireMcpAuth } from '@better-auth/mcp';
import { auth } from '@/lib/auth';
import { getMcpAccessProfile } from '@/lib/mcp/access-profile';
import { getActiveMcpAuthorization } from '@/lib/mcp/authorization';
import { createBesedyMcpServer } from '@/lib/mcp/server';
import {
  resolvePortalActorContext,
  type PortalActorContext,
} from '@/lib/policy/actor';
import { checkRateLimit } from '@/lib/security/rate-limit';
import {
  getMcpJwksUrl,
  getMcpResourceUrl,
  isMcpEnabled,
  MCP_READ_SCOPE,
} from '@/lib/mcp/config';

export const runtime = 'nodejs';

const resourceUrl = isMcpEnabled() ? getMcpResourceUrl() : null;
const jwksUrl = resourceUrl ? getMcpJwksUrl() : null;
const MCP_RATE_WINDOW_MS = 60_000;
const MCP_GLOBAL_RATE_LIMIT = 600;
const MCP_CLIENT_RATE_LIMIT = 300;
const MCP_USER_RATE_LIMIT = 120;

function readScopes(claims: unknown): string[] {
  if (typeof claims !== 'object' || claims === null) {
    return [];
  }
  const value = (claims as Record<string, unknown>).scope;
  if (typeof value === 'string') {
    return value.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === 'string');
  }
  return [];
}

function readBearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/i, '');
}

function jsonRpcAccessDenied(message: string): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      error: { code: -32001, message },
      id: null,
    },
    { status: 403 },
  );
}

function jsonRpcRateLimited(): Response {
  const response = Response.json(
    {
      jsonrpc: '2.0',
      error: { code: -32029, message: 'Too many MCP requests' },
      id: null,
    },
    { status: 429 },
  );
  response.headers.set('Retry-After', '60');
  return response;
}

const mcpHandler = createMcpHandler(
  async ({ authInfo }) => {
    const actor = authInfo?.extra?.actor as PortalActorContext | undefined;
    if (
      !authInfo ||
      !actor?.canEnterPortal ||
      typeof actor.userId !== 'string'
    ) {
      throw new Error('Authenticated MCP request is missing its policy context');
    }
    const accessProfile = await getMcpAccessProfile(actor.userId, { actor });
    return createBesedyMcpServer({
      clientId: authInfo.clientId,
      scopes: authInfo.scopes,
      accessProfile,
    });
  },
  {
    legacy: 'stateless',
    responseMode: 'json',
  },
);

const protectedMcpHandler = resourceUrl
  ? requireMcpAuth(
      auth,
      async (request, claims) => {
        const userId = claims.sub;
        if (typeof userId !== 'string' || userId.length === 0) {
          return jsonRpcAccessDenied(
            'The access token has no Besedy user subject',
          );
        }

        const clientIdClaim = claims.client_id ?? claims.azp;
        if (typeof clientIdClaim !== 'string' || clientIdClaim.length === 0) {
          return jsonRpcAccessDenied(
            'The access token has no OAuth client identity',
          );
        }
        const clientId = clientIdClaim;
        if (
          !checkRateLimit(
            'mcp:authenticated:global',
            MCP_GLOBAL_RATE_LIMIT,
            MCP_RATE_WINDOW_MS,
          ) ||
          !checkRateLimit(
            `mcp:user:${userId}`,
            MCP_USER_RATE_LIMIT,
            MCP_RATE_WINDOW_MS,
          ) ||
          !checkRateLimit(
            `mcp:client:${clientId}`,
            MCP_CLIENT_RATE_LIMIT,
            MCP_RATE_WINDOW_MS,
          )
        ) {
          return jsonRpcRateLimited();
        }

        const tokenScopes = readScopes(claims);
        const authorization = await getActiveMcpAuthorization({
          clientId,
          resourceUrl,
          tokenScopes,
          userId,
        });
        if (!authorization) {
          return jsonRpcAccessDenied(
            'Active Besedy MCP authorization is required',
          );
        }

        const actor = await resolvePortalActorContext(userId);
        if (!actor.canEnterPortal) {
          return jsonRpcAccessDenied('Active Besedy portal access is required');
        }

        const authInfo: AuthInfo = {
          token: readBearerToken(request),
          clientId,
          scopes: authorization.scopes,
          expiresAt: claims.exp,
          resource: new URL(resourceUrl),
          extra: { actor },
        };

        return mcpHandler.fetch(request, { authInfo });
      },
      {
        jwksUrl: jwksUrl!,
        resource: resourceUrl,
        requiredScopes: [MCP_READ_SCOPE],
      },
    )
  : null;

export async function POST(request: Request): Promise<Response> {
  if (!protectedMcpHandler) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  return protectedMcpHandler(request);
}
