import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findClient: vi.fn(),
  findUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  default: {
    oauthClient: { findUnique: mocks.findClient },
    user: { findUnique: mocks.findUser },
  },
}));

import { getMcpIdentity } from '@/lib/mcp/identity';

describe('MCP identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findClient.mockResolvedValue({ name: 'Codex' });
  });

  it('returns the authenticated account and OAuth client', async () => {
    mocks.findUser.mockResolvedValue({
      id: 'user-1',
      name: 'Lukas',
      email: 'lukas@example.com',
    });

    await expect(getMcpIdentity('user-1', 'client-1')).resolves.toEqual({
      userId: 'user-1',
      name: 'Lukas',
      email: 'lukas@example.com',
      clientId: 'client-1',
      clientName: 'Codex',
    });
  });

  it('tolerates missing account and client profile metadata', async () => {
    mocks.findUser.mockResolvedValue({
      id: 'user-1',
      name: null,
      email: null,
    });
    mocks.findClient.mockResolvedValue(null);

    await expect(getMcpIdentity('user-1', 'client-1')).resolves.toMatchObject({
      name: null,
      email: null,
      clientName: null,
    });
  });

  it('returns null when the authenticated user no longer exists', async () => {
    mocks.findUser.mockResolvedValue(null);

    await expect(getMcpIdentity('missing', 'client-1')).resolves.toBeNull();
  });
});
