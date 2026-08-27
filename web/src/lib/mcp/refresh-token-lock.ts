import { Pool, type PoolClient } from 'pg';
import prisma from '@/lib/db';
import { digestMcpOAuthToken } from '@/lib/mcp/token-storage';

const TOKEN_ENDPOINT_SUFFIX = '/oauth2/token';
const LOCK_POOL_SIZE = 4;
const LOCK_CONNECTION_TIMEOUT_MS = 5_000;
const LOCK_STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_RETRY_AFTER_SECONDS = 1;

const globalForMcpRefreshLock = globalThis as unknown as {
  mcpRefreshLockPool: Pool | undefined;
};

let lockPool = globalForMcpRefreshLock.mcpRefreshLockPool;

function getLockPool(): Pool {
  if (lockPool) return lockPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const pool = new Pool({
    connectionString,
    max: LOCK_POOL_SIZE,
    connectionTimeoutMillis: LOCK_CONNECTION_TIMEOUT_MS,
    statement_timeout: LOCK_STATEMENT_TIMEOUT_MS,
  });
  pool.on('error', (error) => {
    // pg-pool has already removed the failed idle client. Handling the event
    // keeps EventEmitter's special `error` behavior from terminating Node.
    console.error('[mcp] Refresh lock pool lost an idle connection', error);
  });
  lockPool = pool;
  if (process.env.APP_ENV !== 'production') {
    globalForMcpRefreshLock.mcpRefreshLockPool = lockPool;
  }

  return lockPool;
}

function temporarilyUnavailable(error: unknown): Response {
  console.error('[mcp] Refresh grant serialization is unavailable', error);
  return Response.json(
    {
      error: 'temporarily_unavailable',
      error_description:
        'The authorization server is temporarily unable to process the refresh grant',
    },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'Retry-After': String(LOCK_RETRY_AFTER_SECONDS),
      },
    },
  );
}

type RefreshFamily = {
  clientId: string;
  userId: string;
  referenceId: string | null;
};

async function getRefreshFamily(
  storedToken: string,
): Promise<RefreshFamily | null> {
  return prisma.oauthRefreshToken.findUnique({
    where: { token: storedToken },
    select: { clientId: true, userId: true, referenceId: true },
  });
}

function refreshTokenIdentity(refreshToken: string): {
  storedToken: string;
  lockKey: [number, number];
} {
  const digest = digestMcpOAuthToken(refreshToken);
  return {
    storedToken: digest.toString('base64url'),
    lockKey: [digest.readInt32BE(0), digest.readInt32BE(4)],
  };
}

async function getRefreshToken(request: Request): Promise<string | null> {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '');
  if (!pathname.endsWith(TOKEN_ENDPOINT_SUFFIX)) return null;

  try {
    const form = await request.clone().formData();
    // Better Call folds form entries into an object, so duplicate fields use
    // their last value. Match that behavior so we lock the token it processes.
    if (form.getAll('grant_type').at(-1) !== 'refresh_token') return null;

    const refreshToken = form.getAll('refresh_token').at(-1);
    return typeof refreshToken === 'string' && refreshToken.length > 0
      ? refreshToken
      : null;
  } catch {
    // Let Better Auth return the protocol-specific error for malformed bodies.
    return null;
  }
}

export async function serializeMcpRefreshTokenGrant(
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  const refreshToken = await getRefreshToken(request);
  if (!refreshToken) return handler();

  const tokenIdentity = refreshTokenIdentity(refreshToken);
  let family: RefreshFamily | null;
  try {
    family = await getRefreshFamily(tokenIdentity.storedToken);
  } catch (error) {
    return temporarilyUnavailable(error);
  }
  if (!family) return handler();

  let client: PoolClient;
  try {
    client = await getLockPool().connect();
  } catch (error) {
    return temporarilyUnavailable(error);
  }
  const tokenLockParameters = tokenIdentity.lockKey;
  const familyLockParameters = [
    family.clientId,
    family.userId,
    family.referenceId,
  ];
  let tokenLocked = false;
  let familyLocked = false;
  let discardClient = false;

  try {
    try {
      await client.query(
        'SELECT pg_advisory_lock($1::integer, $2::integer)',
        tokenLockParameters,
      );
      tokenLocked = true;
      await client.query(
        `SELECT pg_advisory_lock_shared(
          hashtextextended(
            jsonb_build_array($1::text, $2::text, $3::text)::text,
            0
          )
        )`,
        familyLockParameters,
      );
      familyLocked = true;
    } catch (error) {
      discardClient = true;
      return temporarilyUnavailable(error);
    }
    return await handler();
  } finally {
    if (familyLocked) {
      try {
        await client.query(
          `SELECT pg_advisory_unlock_shared(
            hashtextextended(
              jsonb_build_array($1::text, $2::text, $3::text)::text,
              0
            )
          )`,
          familyLockParameters,
        );
      } catch {
        discardClient = true;
      }
    }
    if (tokenLocked) {
      try {
        await client.query(
          'SELECT pg_advisory_unlock($1::integer, $2::integer)',
          tokenLockParameters,
        );
      } catch {
        discardClient = true;
      }
    }
    // Destroying the connection releases any session-level locks that an
    // interrupted unlock left behind.
    client.release(discardClient);
  }
}
