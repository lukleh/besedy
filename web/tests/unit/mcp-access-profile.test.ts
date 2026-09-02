import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMcpAccessProfile } from '@/lib/mcp/access-profile';
import { listUserCatalogAccessEntries } from '@/lib/access/catalog-access-queries';
import { getUserFeaturePreferences } from '@/lib/features/capabilities';
import { resolvePortalActorContext } from '@/lib/policy/actor';

vi.mock('@/lib/access/catalog-access-queries', () => ({
  listUserCatalogAccessEntries: vi.fn(),
}));

vi.mock('@/lib/policy/actor', () => ({
  resolvePortalActorContext: vi.fn(),
}));

vi.mock('@/lib/features/capabilities', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/features/capabilities')
  >('@/lib/features/capabilities');
  return {
    ...actual,
    getUserFeaturePreferences: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({
  default: {
    workflowGroup: { findMany: vi.fn() },
  },
}));

describe('MCP access profile', () => {
  let prisma: {
    workflowGroup: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = (await import('@/lib/db')).default as unknown as typeof prisma;
    vi.mocked(resolvePortalActorContext).mockResolvedValue({
      userId: 'user-1',
      isAuthenticated: true,
      userStatus: 'ACTIVE',
      systemRole: 'USER',
      canEnterPortal: true,
    });
    vi.mocked(listUserCatalogAccessEntries).mockResolvedValue([
      { catalogId: 'catalog-listener', accessLevel: 'LISTENER' },
      { catalogId: 'catalog-viewer', accessLevel: 'VIEWER' },
    ]);
    vi.mocked(getUserFeaturePreferences).mockResolvedValue({
      activeGroupId: 'catalog-viewer',
      labsPreference: {
        enabled: false,
        updatedAt: null,
      },
    });
    prisma.workflowGroup.findMany.mockResolvedValue([
      { id: 'catalog-listener', label: 'Listener', isDefault: true },
      { id: 'catalog-viewer', label: 'Viewer', isDefault: false },
    ]);
  });

  it('gives every accessible catalog the uniform MCP read surface', async () => {
    const profile = await getMcpAccessProfile('user-1');

    expect(profile.canEnterPortal).toBe(true);
    expect(profile.catalogs).toEqual([
      expect.objectContaining({
        id: 'catalog-listener',
        isDefault: false,
      }),
      expect.objectContaining({
        id: 'catalog-viewer',
        isDefault: true,
      }),
    ]);
    expect(profile.defaultCatalogId).toBe('catalog-viewer');
    expect(profile.defaultCatalogSource).toBe('user_preference');
  });

  it('returns no MCP catalogs for a blocked user', async () => {
    vi.mocked(resolvePortalActorContext).mockResolvedValue({
      userId: 'blocked-1',
      isAuthenticated: true,
      userStatus: 'BLOCKED',
      systemRole: 'USER',
      canEnterPortal: false,
    });

    await expect(getMcpAccessProfile('blocked-1')).resolves.toEqual({
      userId: 'blocked-1',
      canEnterPortal: false,
      defaultCatalogId: null,
      defaultCatalogSource: null,
      catalogs: [],
    });
    expect(prisma.workflowGroup.findMany).not.toHaveBeenCalled();
    expect(listUserCatalogAccessEntries).not.toHaveBeenCalled();
  });

  it('keeps an active user without grants eligible for MCP tools but no catalogs', async () => {
    vi.mocked(listUserCatalogAccessEntries).mockResolvedValue([]);
    prisma.workflowGroup.findMany.mockResolvedValue([]);

    await expect(getMcpAccessProfile('user-1')).resolves.toMatchObject({
      canEnterPortal: true,
      defaultCatalogId: null,
      catalogs: [],
    });
  });

  it('reuses a provided canonical actor', async () => {
    const actor = {
      userId: 'user-1',
      isAuthenticated: true,
      userStatus: 'ACTIVE' as const,
      systemRole: 'USER' as const,
      canEnterPortal: true,
    };

    const profile = await getMcpAccessProfile('user-1', { actor });

    expect(resolvePortalActorContext).not.toHaveBeenCalled();
    expect(profile).toMatchObject({
      userId: 'user-1',
      canEnterPortal: true,
    });
  });

  it('rejects a provided actor for a different user', async () => {
    await expect(
      getMcpAccessProfile('user-1', {
        actor: {
          userId: 'user-2',
          isAuthenticated: true,
          userStatus: 'ACTIVE',
          systemRole: 'USER',
          canEnterPortal: true,
        },
      }),
    ).rejects.toThrow(
      'MCP access profile actor does not match the requested user',
    );
    expect(getUserFeaturePreferences).not.toHaveBeenCalled();
  });

  it('keeps catalog admin discovery while applying listener visibility', async () => {
    vi.mocked(resolvePortalActorContext).mockResolvedValue({
      userId: 'admin-1',
      isAuthenticated: true,
      userStatus: 'ACTIVE',
      systemRole: 'ADMIN',
      canEnterPortal: true,
    });
    vi.mocked(listUserCatalogAccessEntries).mockResolvedValue([
      { catalogId: 'catalog-listener', accessLevel: 'OWNER' },
    ]);
    prisma.workflowGroup.findMany.mockResolvedValue([
      { id: 'catalog-listener', label: 'Admin catalog', isDefault: true },
    ]);

    const profile = await getMcpAccessProfile('admin-1');

    expect(profile.canEnterPortal).toBe(true);
    expect(profile.catalogs).toEqual([
      { id: 'catalog-listener', label: 'Admin catalog', isDefault: true },
    ]);
  });
});
