import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findConsent: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  default: {
    oauthConsent: { findFirst: mocks.findConsent },
  },
}));

import { hasActiveMcpAuthorization } from '@/lib/mcp/authorization';

describe('MCP authorization liveness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires live consent for an enabled client and resource', async () => {
    mocks.findConsent.mockResolvedValue({ id: 'consent-1' });

    await expect(
      hasActiveMcpAuthorization({
        clientId: 'client-1',
        resourceUrl: 'https://besedy.example/api/mcp',
        userId: 'user-1',
      }),
    ).resolves.toBe(true);

    expect(mocks.findConsent).toHaveBeenCalledWith({
      where: {
        clientId: 'client-1',
        userId: 'user-1',
        scopes: { has: 'besedy:read' },
        resources: { has: 'https://besedy.example/api/mcp' },
        client: {
          disabled: false,
          resources: {
            some: {
              resourceId: 'https://besedy.example/api/mcp',
              resource: { disabled: false },
            },
          },
        },
      },
      select: { id: true },
    });
  });

  it('rejects a token whose consent or client is no longer active', async () => {
    mocks.findConsent.mockResolvedValue(null);

    await expect(
      hasActiveMcpAuthorization({
        clientId: 'client-1',
        resourceUrl: 'https://besedy.example/api/mcp',
        userId: 'user-1',
      }),
    ).resolves.toBe(false);
  });
});
