import { describe, expect, it } from 'vitest';
import { normalizeClaudeCodeLoopbackRequest } from '@/lib/auth/claude-code-loopback';

const CLAUDE_CODE_CLIENT_ID =
  'https://claude.ai/oauth/claude-code-client-metadata';
const LOCALHOST_CALLBACK = 'http://localhost:65313/callback';
const IP_CALLBACK = 'http://127.0.0.1:65313/callback';

function authorizationRequest(
  redirectUri = LOCALHOST_CALLBACK,
  clientId = CLAUDE_CODE_CLIENT_ID,
): Request {
  const url = new URL('https://besedy.example/api/auth/oauth2/authorize');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: 'test-state',
  }).toString();
  return new Request(url, {
    headers: { 'x-test-header': 'preserved' },
  });
}

function tokenRequest({
  body,
  contentType = 'application/x-www-form-urlencoded; charset=UTF-8',
}: {
  body?: string;
  contentType?: string;
} = {}): Request {
  return new Request('https://besedy.example/api/auth/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Content-Length': '999',
      'X-Test-Header': 'preserved',
    },
    body:
      body ??
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLAUDE_CODE_CLIENT_ID,
        code: 'test-code',
        redirect_uri: LOCALHOST_CALLBACK,
        code_verifier: 'test-verifier',
      }).toString(),
  });
}

describe('Claude Code OAuth loopback compatibility', () => {
  it('normalizes the authorization redirect to the listener IP', async () => {
    const request = authorizationRequest();

    const normalized = await normalizeClaudeCodeLoopbackRequest(request);
    const normalizedUrl = new URL(normalized.url);

    expect(normalized).not.toBe(request);
    expect(normalizedUrl.searchParams.get('redirect_uri')).toBe(IP_CALLBACK);
    expect(normalizedUrl.searchParams.get('state')).toBe('test-state');
    expect(normalized.headers.get('x-test-header')).toBe('preserved');
    expect(new URL(request.url).searchParams.get('redirect_uri')).toBe(
      LOCALHOST_CALLBACK,
    );
  });

  it('normalizes the matching authorization-code token request', async () => {
    const body = new URLSearchParams([
      ['grant_type', 'authorization_code'],
      ['client_id', CLAUDE_CODE_CLIENT_ID],
      ['code', 'test-code'],
      ['redirect_uri', LOCALHOST_CALLBACK],
      ['resource', 'https://resource.example/one'],
      ['resource', 'https://resource.example/two'],
    ]).toString();

    const normalized = await normalizeClaudeCodeLoopbackRequest(
      tokenRequest({ body }),
    );
    const parameters = new URLSearchParams(await normalized.text());

    expect(parameters.get('redirect_uri')).toBe(IP_CALLBACK);
    expect(parameters.get('code')).toBe('test-code');
    expect(parameters.getAll('resource')).toEqual([
      'https://resource.example/one',
      'https://resource.example/two',
    ]);
    expect(normalized.headers.get('content-length')).toBeNull();
    expect(normalized.headers.get('x-test-header')).toBe('preserved');
  });

  it.each([
    {
      name: 'another client',
      request: () => authorizationRequest(LOCALHOST_CALLBACK, 'other-client'),
    },
    {
      name: 'a portless callback',
      request: () => authorizationRequest('http://localhost/callback'),
    },
    {
      name: 'an HTTPS callback',
      request: () => authorizationRequest('https://localhost:65313/callback'),
    },
    {
      name: 'a different callback path',
      request: () => authorizationRequest('http://localhost:65313/other'),
    },
    {
      name: 'an already normalized callback',
      request: () => authorizationRequest(IP_CALLBACK),
    },
    {
      name: 'a duplicate client ID',
      request: () => {
        const request = authorizationRequest();
        const url = new URL(request.url);
        url.searchParams.append('client_id', CLAUDE_CODE_CLIENT_ID);
        return new Request(url);
      },
    },
  ])('leaves $name authorization request untouched', async ({ request }) => {
    const original = request();

    const normalized = await normalizeClaudeCodeLoopbackRequest(original);

    expect(normalized).toBe(original);
  });

  it.each([
    {
      name: 'a refresh grant',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLAUDE_CODE_CLIENT_ID,
        redirect_uri: LOCALHOST_CALLBACK,
      }).toString(),
      contentType: undefined,
    },
    {
      name: 'a non-form request',
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: CLAUDE_CODE_CLIENT_ID,
        redirect_uri: LOCALHOST_CALLBACK,
      }),
      contentType: 'application/json',
    },
    {
      name: 'duplicate redirect URIs',
      body:
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CLAUDE_CODE_CLIENT_ID,
          redirect_uri: LOCALHOST_CALLBACK,
        }).toString() +
        `&redirect_uri=${encodeURIComponent(LOCALHOST_CALLBACK)}`,
      contentType: undefined,
    },
  ])('leaves $name token request untouched', async ({ body, contentType }) => {
    const original = tokenRequest({
      body,
      ...(contentType ? { contentType } : {}),
    });

    const normalized = await normalizeClaudeCodeLoopbackRequest(original);

    expect(normalized).toBe(original);
  });

  it('leaves unrelated auth endpoints untouched', async () => {
    const request = new Request(
      `https://besedy.example/api/auth/session?client_id=${encodeURIComponent(CLAUDE_CODE_CLIENT_ID)}&redirect_uri=${encodeURIComponent(LOCALHOST_CALLBACK)}`,
    );

    const normalized = await normalizeClaudeCodeLoopbackRequest(request);

    expect(normalized).toBe(request);
  });
});
