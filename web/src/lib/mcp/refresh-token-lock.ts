import { createHash } from 'node:crypto';
import { Pool } from 'pg';

const TOKEN_ENDPOINT_PATH = '/api/auth/oauth2/token';

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

  lockPool = new Pool({ connectionString, max: 4 });
  if (process.env.APP_ENV !== 'production') {
    globalForMcpRefreshLock.mcpRefreshLockPool = lockPool;
  }

  return lockPool;
}

function advisoryLockKey(refreshToken: string): [number, number] {
  const digest = createHash('sha256').update(refreshToken).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

async function getRefreshToken(request: Request): Promise<string | null> {
  if (new URL(request.url).pathname !== TOKEN_ENDPOINT_PATH) return null;

  try {
    const form = await request.clone().formData();
    if (form.get('grant_type') !== 'refresh_token') return null;

    const refreshToken = form.get('refresh_token');
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

  const client = await getLockPool().connect();
  const [key1, key2] = advisoryLockKey(refreshToken);
  let locked = false;
  let discardClient = false;

  try {
    try {
      await client.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [
        key1,
        key2,
      ]);
    } catch (error) {
      discardClient = true;
      throw error;
    }
    locked = true;
    return await handler();
  } finally {
    if (locked) {
      try {
        await client.query(
          'SELECT pg_advisory_unlock($1::integer, $2::integer)',
          [key1, key2],
        );
      } catch {
        // Destroying the connection releases its session-level lock.
        discardClient = true;
      }
    }
    client.release(discardClient);
  }
}
