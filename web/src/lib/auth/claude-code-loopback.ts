const CLAUDE_CODE_CLIENT_ID =
  'https://claude.ai/oauth/claude-code-client-metadata';
const AUTHORIZE_ENDPOINT_SUFFIX = '/oauth2/authorize';
const TOKEN_ENDPOINT_SUFFIX = '/oauth2/token';

function getSingleParameter(
  parameters: URLSearchParams,
  name: string,
): string | null {
  const values = parameters.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function normalizeLoopbackCallback(value: string): string | null {
  let redirectUri: URL;
  try {
    redirectUri = new URL(value);
  } catch {
    return null;
  }

  if (
    redirectUri.protocol !== 'http:' ||
    redirectUri.hostname !== 'localhost' ||
    redirectUri.port.length === 0 ||
    redirectUri.pathname !== '/callback' ||
    redirectUri.search.length > 0 ||
    redirectUri.hash.length > 0 ||
    redirectUri.username.length > 0 ||
    redirectUri.password.length > 0
  ) {
    return null;
  }

  redirectUri.hostname = '127.0.0.1';
  return redirectUri.toString();
}

function hasEndpointSuffix(pathname: string, suffix: string): boolean {
  return pathname.replace(/\/+$/, '').endsWith(suffix);
}

function rebuildRequest(request: Request, url: URL, body?: BodyInit): Request {
  const headers = new Headers(request.headers);
  if (body !== undefined) headers.delete('content-length');

  return new Request(url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
  });
}

function normalizeAuthorizeRequest(request: Request, url: URL): Request {
  const clientId = getSingleParameter(url.searchParams, 'client_id');
  const redirectUri = getSingleParameter(url.searchParams, 'redirect_uri');
  if (clientId !== CLAUDE_CODE_CLIENT_ID || !redirectUri) return request;

  const normalizedRedirectUri = normalizeLoopbackCallback(redirectUri);
  if (!normalizedRedirectUri) return request;

  url.searchParams.set('redirect_uri', normalizedRedirectUri);
  return rebuildRequest(request, url);
}

async function normalizeTokenRequest(
  request: Request,
  url: URL,
): Promise<Request> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0];
  if (
    contentType?.trim().toLowerCase() !== 'application/x-www-form-urlencoded'
  ) {
    return request;
  }

  let parameters: URLSearchParams;
  try {
    parameters = new URLSearchParams(await request.clone().text());
  } catch {
    return request;
  }

  const grantType = getSingleParameter(parameters, 'grant_type');
  const clientId = getSingleParameter(parameters, 'client_id');
  const redirectUri = getSingleParameter(parameters, 'redirect_uri');
  if (
    grantType !== 'authorization_code' ||
    clientId !== CLAUDE_CODE_CLIENT_ID ||
    !redirectUri
  ) {
    return request;
  }

  const normalizedRedirectUri = normalizeLoopbackCallback(redirectUri);
  if (!normalizedRedirectUri) return request;

  parameters.set('redirect_uri', normalizedRedirectUri);
  return rebuildRequest(request, url, parameters);
}

/**
 * Claude Code publishes a portless 127.0.0.1 callback in its CIMD document,
 * but versions through 2.1.247 still send localhost with an ephemeral port.
 * Its callback listener already binds to 127.0.0.1, so normalize only that
 * client's exact loopback callback shape before Better Auth validates it.
 */
export async function normalizeClaudeCodeLoopbackRequest(
  request: Request,
): Promise<Request> {
  const url = new URL(request.url);
  if (
    request.method === 'GET' &&
    hasEndpointSuffix(url.pathname, AUTHORIZE_ENDPOINT_SUFFIX)
  ) {
    return normalizeAuthorizeRequest(request, url);
  }
  if (
    request.method === 'POST' &&
    hasEndpointSuffix(url.pathname, TOKEN_ENDPOINT_SUFFIX)
  ) {
    return normalizeTokenRequest(request, url);
  }
  return request;
}
