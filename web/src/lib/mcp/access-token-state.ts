import { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/db';
import { createServerLogger } from '@/lib/log/server';
import { getMcpResourceUrl } from '@/lib/mcp/config';
import { hashMcpOAuthToken } from '@/lib/mcp/token-storage';
import {
  decodeBasicCredentials,
  stripAccessTokenAuthorizationScheme,
} from 'better-auth/oauth2';

const TOKEN_ENDPOINT_SUFFIX = '/oauth2/token';
const REVOCATION_ENDPOINT_SUFFIX = '/oauth2/revoke';
const logger = createServerLogger('mcp-access-token-state');

interface JwtClaims {
  aud: string[];
  clientId: string;
  confirmation?: Prisma.InputJsonValue;
  expiresAt: Date;
  issuedAt: Date;
  jti: string;
  scopes: string[];
  sessionId: string | null;
  userId: string | null;
}

interface StoredAccessTokenIdentity {
  accessToken: string;
  clientId: string;
  resourceUrl: string;
  userId: string;
}

export interface ActiveStoredMcpAccessToken {
  scopes: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function endpointPath(request: Request): string {
  return new URL(request.url).pathname.replace(/\/+$/, '');
}

function decodeJwtPayload(accessToken: string): Record<string, unknown> {
  const parts = accessToken.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('MCP access token response did not contain a JWT');
  }
  const payload = asRecord(
    JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
  );
  if (!payload) throw new Error('MCP access token JWT payload is invalid');
  return payload;
}

function readJwtClaims(accessToken: string, resourceUrl: string): JwtClaims {
  const payload = decodeJwtPayload(accessToken);
  const clientId = nonEmptyString(payload.client_id ?? payload.azp);
  const jti = nonEmptyString(payload.jti);
  const subject = nonEmptyString(payload.sub);
  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  const aud = Array.isArray(payload.aud)
    ? payload.aud.filter((value): value is string => typeof value === 'string')
    : typeof payload.aud === 'string'
      ? [payload.aud]
      : [];
  const scopes =
    typeof payload.scope === 'string'
      ? payload.scope.split(/\s+/).filter(Boolean)
      : [];

  if (
    !clientId ||
    !jti ||
    !subject ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    (expiresAt as number) <= (issuedAt as number) ||
    !aud.includes(resourceUrl) ||
    scopes.length === 0
  ) {
    throw new Error('MCP access token JWT is missing required persisted claims');
  }

  const confirmation = asRecord(payload.cnf);
  return {
    aud,
    clientId,
    ...(confirmation
      ? { confirmation: confirmation as Prisma.InputJsonValue }
      : {}),
    expiresAt: new Date((expiresAt as number) * 1_000),
    issuedAt: new Date((issuedAt as number) * 1_000),
    jti,
    scopes,
    sessionId: nonEmptyString(payload.sid),
    userId: subject === clientId ? null : subject,
  };
}

async function readJsonObject(response: Response) {
  try {
    return asRecord(await response.clone().json());
  } catch {
    return null;
  }
}

function temporarilyUnavailable(error: unknown): Response {
  logger.error('Failed to synchronize MCP access-token state', error);
  return Response.json(
    {
      error: 'temporarily_unavailable',
      error_description:
        'The authorization server is temporarily unable to persist access-token state',
    },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'Retry-After': '1',
      },
    },
  );
}

async function persistIssuedAccessToken(response: Response): Promise<void> {
  const body = await readJsonObject(response);
  const accessToken = nonEmptyString(body?.access_token);
  if (!body || !accessToken) {
    throw new Error('Successful MCP token response is missing access_token');
  }

  const claims = readJwtClaims(accessToken, getMcpResourceUrl());
  const refreshToken = nonEmptyString(body.refresh_token);
  const refresh = refreshToken
    ? await prisma.oauthRefreshToken.findUnique({
        where: { token: hashMcpOAuthToken(refreshToken) },
        select: { id: true, clientId: true, userId: true },
      })
    : null;
  if (
    refreshToken &&
    (!refresh ||
      refresh.clientId !== claims.clientId ||
      refresh.userId !== claims.userId)
  ) {
    throw new Error('Issued MCP refresh-token family could not be resolved');
  }

  await prisma.oauthAccessToken.upsert({
    where: { token: hashMcpOAuthToken(accessToken) },
    update: {},
    create: {
      id: claims.jti,
      token: hashMcpOAuthToken(accessToken),
      clientId: claims.clientId,
      sessionId: claims.sessionId,
      userId: claims.userId,
      resources: claims.aud,
      requestedUserInfoClaims: [],
      refreshId: refresh?.id ?? null,
      expiresAt: claims.expiresAt,
      createdAt: claims.issuedAt,
      confirmation: claims.confirmation,
      scopes: claims.scopes,
    },
  });
}

async function revokingClientId(request: Request): Promise<string | null> {
  const form = await request.formData();
  const bodyClientId = form.getAll('client_id').at(-1);
  if (typeof bodyClientId === 'string' && bodyClientId.length > 0) {
    return bodyClientId;
  }

  const authorization = request.headers.get('authorization');
  if (!authorization) return null;
  try {
    return decodeBasicCredentials(authorization).clientId;
  } catch {
    return null;
  }
}

async function applyJwtRevocation(
  request: Request,
  response: Response,
): Promise<Response> {
  const body = await readJsonObject(response);
  if (body?.error !== 'unsupported_token_type') return response;

  const clientRequest = request.clone();
  const form = await request.formData();
  const token = form.getAll('token').at(-1);
  const clientId = await revokingClientId(clientRequest);
  if (typeof token !== 'string' || token.length === 0 || !clientId) {
    return response;
  }

  const normalizedToken = stripAccessTokenAuthorizationScheme(token);
  await prisma.oauthAccessToken.updateMany({
    where: {
      token: hashMcpOAuthToken(normalizedToken),
      clientId,
      revoked: null,
    },
    data: { revoked: new Date() },
  });
  return new Response(null, {
    status: 200,
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

export async function synchronizeMcpAccessTokenState(
  request: Request,
  response: Response,
): Promise<Response> {
  const path = endpointPath(request);
  try {
    if (path.endsWith(TOKEN_ENDPOINT_SUFFIX) && response.ok) {
      await persistIssuedAccessToken(response);
    } else if (path.endsWith(REVOCATION_ENDPOINT_SUFFIX)) {
      return await applyJwtRevocation(request, response);
    }
    return response;
  } catch (error) {
    return temporarilyUnavailable(error);
  }
}

export async function getActiveStoredMcpAccessToken({
  accessToken,
  clientId,
  resourceUrl,
  userId,
}: StoredAccessTokenIdentity): Promise<ActiveStoredMcpAccessToken | null> {
  if (!accessToken) return null;
  const stored = await prisma.oauthAccessToken.findUnique({
    where: { token: hashMcpOAuthToken(accessToken) },
    select: {
      clientId: true,
      userId: true,
      resources: true,
      scopes: true,
      expiresAt: true,
      revoked: true,
    },
  });
  if (
    !stored ||
    stored.clientId !== clientId ||
    stored.userId !== userId ||
    !stored.resources.includes(resourceUrl) ||
    stored.expiresAt <= new Date() ||
    stored.revoked !== null
  ) {
    return null;
  }
  return { scopes: stored.scopes };
}
