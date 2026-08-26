const DEFAULT_AUTH_ORIGIN = 'http://localhost:3001';

export const MCP_READ_SCOPE = 'besedy:read';
export const MCP_AUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  MCP_READ_SCOPE,
] as const;

// Codex can keep several tasks connected to the same MCP credential. Keep
// access tokens long-lived so routine app restarts do not create a refresh
// stampede, and allow identical refresh retries enough time to receive the
// already-rotated response instead of invalidating the token family.
export const MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;
export const MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 365;
export const MCP_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS = 60 * 5;

function isProductionRuntime(
  appEnv = process.env.APP_ENV,
  nodeEnv = process.env.NODE_ENV,
): boolean {
  if (appEnv === 'production') return true;
  if (appEnv === 'development' || appEnv === 'test') return false;
  return nodeEnv === 'production';
}

export function isMcpEnabled(
  configured = process.env.BESEDY_MCP_ENABLED,
  appEnv = process.env.APP_ENV,
  nodeEnv = process.env.NODE_ENV,
): boolean {
  const normalized = configured?.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (normalized) {
    throw new Error("BESEDY_MCP_ENABLED must be either 'true' or 'false'");
  }

  return !isProductionRuntime(appEnv, nodeEnv);
}

export function getMcpResourceUrl(
  authUrl = process.env.AUTH_URL,
  appEnv = process.env.APP_ENV,
  nodeEnv = process.env.NODE_ENV,
): string {
  const production = isProductionRuntime(appEnv, nodeEnv);
  const configuredAuthUrl = authUrl?.trim();
  if (!configuredAuthUrl && production) {
    throw new Error(
      'AUTH_URL is required when Besedy MCP is enabled in production',
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(configuredAuthUrl || DEFAULT_AUTH_ORIGIN);
  } catch {
    throw new Error(
      'AUTH_URL must be an absolute URL when Besedy MCP is enabled',
    );
  }

  if (baseUrl.username || baseUrl.password) {
    throw new Error('AUTH_URL must not include credentials');
  }
  if (production && baseUrl.protocol !== 'https:') {
    throw new Error(
      'AUTH_URL must use HTTPS when Besedy MCP is enabled in production',
    );
  }

  return new URL('/api/mcp', baseUrl).toString();
}

export function getMcpJwksUrl(
  configuredJwksUrl = process.env.BESEDY_MCP_JWKS_URL,
  authUrl = process.env.AUTH_URL,
  appEnv = process.env.APP_ENV,
  nodeEnv = process.env.NODE_ENV,
): string {
  const configured = configuredJwksUrl?.trim();
  if (!configured) {
    const resourceUrl = getMcpResourceUrl(authUrl, appEnv, nodeEnv);
    return new URL('/api/auth/jwks', resourceUrl).toString();
  }

  let jwksUrl: URL;
  try {
    jwksUrl = new URL(configured);
  } catch {
    throw new Error('BESEDY_MCP_JWKS_URL must be an absolute URL');
  }
  if (jwksUrl.username || jwksUrl.password) {
    throw new Error('BESEDY_MCP_JWKS_URL must not include credentials');
  }
  if (jwksUrl.protocol !== 'http:' && jwksUrl.protocol !== 'https:') {
    throw new Error('BESEDY_MCP_JWKS_URL must use HTTP or HTTPS');
  }

  return jwksUrl.toString();
}
