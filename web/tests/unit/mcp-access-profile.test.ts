import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMcpAccessProfile } from '@/lib/mcp/access-profile';
import { requireArchive } from '@/lib/archive';
import { resolvePortalActorContext } from '@/lib/policy/actor';

vi.mock('@/lib/archive', () => ({ requireArchive: vi.fn() }));
vi.mock('@/lib/policy/actor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/policy/actor')>()),
  resolvePortalActorContext: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  default: { catalogAccess: { findUnique: vi.fn() } },
}));

const actor = {
  userId: 'user-1',
  isAuthenticated: true,
  userStatus: 'ACTIVE' as const,
  systemRole: 'USER' as const,
  canEnterPortal: true,
};
const archive = { id: 'bound-archive', label: 'Besedy' };

describe('MCP access profile', () => {
  let findAccess: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    findAccess = (await import('@/lib/db')).default.catalogAccess.findUnique as unknown as typeof findAccess;
    vi.mocked(resolvePortalActorContext).mockResolvedValue(actor);
    vi.mocked(requireArchive).mockResolvedValue(archive);
    findAccess.mockResolvedValue({ status: 'ACTIVE' });
  });

  it('checks only the configured archive membership for the authenticated actor', async () => {
    await expect(getMcpAccessProfile('user-1')).resolves.toEqual({
      userId: 'user-1', canEnterPortal: true, archive,
    });
    expect(findAccess).toHaveBeenCalledWith({
      where: { userId_catalogId: { userId: 'user-1', catalogId: archive.id } },
      select: { status: true },
    });
  });

  it('returns no archive access for a blocked actor', async () => {
    vi.mocked(resolvePortalActorContext).mockResolvedValue({
      ...actor, userStatus: 'BLOCKED', canEnterPortal: false,
    });
    await expect(getMcpAccessProfile('user-1')).resolves.toEqual({
      userId: 'user-1', canEnterPortal: false, archive: null,
    });
    expect(requireArchive).not.toHaveBeenCalled();
    expect(findAccess).not.toHaveBeenCalled();
  });

  it.each([null, { status: 'REVOKED' }])('withholds archive access for a missing or revoked membership (%s)', async (access) => {
    findAccess.mockResolvedValue(access);
    await expect(getMcpAccessProfile('user-1')).resolves.toMatchObject({
      canEnterPortal: true, archive: null,
    });
  });

  it('reuses the canonical actor provided by verified request authentication', async () => {
    const profile = await getMcpAccessProfile('user-1', { actor });
    expect(resolvePortalActorContext).not.toHaveBeenCalled();
    expect(profile.archive).toEqual(archive);
  });

  it('rejects a provided actor for a different user before reading access', async () => {
    await expect(getMcpAccessProfile('user-1', {
      actor: { ...actor, userId: 'user-2' },
    })).rejects.toThrow('MCP access profile actor does not match the requested user');
    expect(requireArchive).not.toHaveBeenCalled();
    expect(findAccess).not.toHaveBeenCalled();
  });

  it('retains system-admin authority on only the bound archive', async () => {
    vi.mocked(resolvePortalActorContext).mockResolvedValue({ ...actor, systemRole: 'ADMIN' });
    await expect(getMcpAccessProfile('user-1')).resolves.toMatchObject({ archive });
    expect(findAccess).not.toHaveBeenCalled();
  });

  it('fails when the archive binding is invalid instead of choosing another source', async () => {
    vi.mocked(requireArchive).mockRejectedValue(new Error('Archive binding is invalid'));
    await expect(getMcpAccessProfile('user-1')).rejects.toThrow('Archive binding is invalid');
    expect(findAccess).not.toHaveBeenCalled();
  });
});
