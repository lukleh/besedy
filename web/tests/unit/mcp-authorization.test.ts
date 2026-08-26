import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findClient: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  default: {
    oauthClient: { findUnique: mocks.findClient },
  },
}));

import { getActiveMcpAuthorization } from '@/lib/mcp/authorization';

const authorizationRequest = {
  clientId: 'client-1',
  resourceUrl: 'https://besedy.example/api/mcp',
  tokenScopes: ['openid', 'profile', 'email', 'besedy:read'],
  userId: 'user-1',
};

describe('MCP authorization liveness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the intersection of token scopes and live consent scopes', async () => {
    mocks.findClient.mockResolvedValue({
      disabled: false,
      skipConsent: false,
      resources: [{ resource: { disabled: false } }],
      consents: [{ scopes: ['openid', 'profile', 'besedy:read'] }],
    });

    await expect(
      getActiveMcpAuthorization(authorizationRequest),
    ).resolves.toEqual({
      scopes: ['openid', 'profile', 'besedy:read'],
    });

    expect(mocks.findClient).toHaveBeenCalledWith({
      where: { clientId: 'client-1' },
      select: {
        disabled: true,
        skipConsent: true,
        resources: {
          where: { resourceId: 'https://besedy.example/api/mcp' },
          select: {
            resource: { select: { disabled: true } },
          },
        },
        consents: {
          where: { userId: 'user-1' },
          select: { scopes: true },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
    });
  });

  it('supports consent-free clients and nullable enabled flags', async () => {
    mocks.findClient.mockResolvedValue({
      disabled: null,
      skipConsent: true,
      resources: [{ resource: { disabled: null } }],
      consents: [],
    });

    await expect(
      getActiveMcpAuthorization(authorizationRequest),
    ).resolves.toEqual({ scopes: authorizationRequest.tokenScopes });
  });

  it('rejects consent that no longer grants MCP read access', async () => {
    mocks.findClient.mockResolvedValue({
      disabled: false,
      skipConsent: false,
      resources: [{ resource: { disabled: false } }],
      consents: [{ scopes: ['openid', 'profile'] }],
    });

    await expect(
      getActiveMcpAuthorization(authorizationRequest),
    ).resolves.toBeNull();
  });

  it.each([
    null,
    {
      disabled: true,
      skipConsent: false,
      resources: [{ resource: { disabled: false } }],
      consents: [{ scopes: ['besedy:read'] }],
    },
    {
      disabled: false,
      skipConsent: false,
      resources: [{ resource: { disabled: true } }],
      consents: [{ scopes: ['besedy:read'] }],
    },
  ])('rejects a missing or disabled client/resource', async (client) => {
    mocks.findClient.mockResolvedValue(client);

    await expect(
      getActiveMcpAuthorization(authorizationRequest),
    ).resolves.toBeNull();
  });
});
