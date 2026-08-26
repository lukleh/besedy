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

  it('derives listener and viewer MCP capabilities from canonical policy', async () => {
    const profile = await getMcpAccessProfile('user-1');

    expect(profile.catalogs).toEqual([
      expect.objectContaining({
        id: 'catalog-listener',
        isUserDefault: false,
        isGlobalDefault: true,
        isEffectiveDefault: false,
        catalogGrant: 'LISTENER',
        isCatalogAdmin: false,
        capabilities: {
          canListEvents: true,
          canGetRecordings: true,
          canViewTranscripts: false,
          canSearchTranscripts: false,
          canSeeUnreleasedEvents: false,
        },
      }),
      expect.objectContaining({
        id: 'catalog-viewer',
        isUserDefault: true,
        isGlobalDefault: false,
        isEffectiveDefault: true,
        catalogGrant: 'VIEWER',
        isCatalogAdmin: false,
        capabilities: {
          canListEvents: true,
          canGetRecordings: true,
          canViewTranscripts: true,
          canSearchTranscripts: true,
          canSeeUnreleasedEvents: true,
        },
      }),
    ]);
    expect(profile.defaultCatalogId).toBe('catalog-viewer');
    expect(profile.defaultCatalogSource).toBe('user_preference');
    expect(profile.aggregate).toEqual({
      canListEvents: true,
      canGetRecordings: true,
      canViewTranscripts: true,
      canSearchTranscripts: true,
    });
  });

  it('returns no MCP catalogs for a blocked user', async () => {
    vi.mocked(resolvePortalActorContext).mockResolvedValue({
      userId: 'blocked-1',
      isAuthenticated: true,
      userStatus: 'BLOCKED',
      systemRole: 'USER',
      canEnterPortal: false,
    });

    await expect(getMcpAccessProfile('blocked-1')).resolves.toMatchObject({
      canEnterPortal: false,
      catalogs: [],
    });
    expect(prisma.workflowGroup.findMany).not.toHaveBeenCalled();
    expect(listUserCatalogAccessEntries).not.toHaveBeenCalled();
  });

  it('gives catalog admins the complete read surface', async () => {
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

    expect(profile.catalogs[0]).toMatchObject({
      catalogGrant: null,
      isCatalogAdmin: true,
      capabilities: {
        canListEvents: true,
        canGetRecordings: true,
        canViewTranscripts: true,
        canSearchTranscripts: true,
        canSeeUnreleasedEvents: true,
      },
    });
  });
});
