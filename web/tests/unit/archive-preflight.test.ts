import { afterEach, describe, expect, it, vi } from 'vitest';
import { findArchiveGrantConflicts, inspectArchiveMigration } from '@/lib/archive-preflight';
import prisma from '@/lib/db';

const mocks = vi.hoisted(() => ({
  tx: {
    $executeRaw: vi.fn(),
    workflowGroup: { findMany: vi.fn() },
    catalogAccess: { findMany: vi.fn() },
    pendingCatalogGrant: { findMany: vi.fn() },
    portalAdmission: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    recordingIntake: { findMany: vi.fn() },
    transcriptPublication: { groupBy: vi.fn(), findMany: vi.fn() },
    transcriptWorkspace: { findMany: vi.fn() },
  },
}));
vi.mock('@/lib/db', () => ({ default: { $transaction: vi.fn((fn) => fn(mocks.tx)) } }));
afterEach(() => vi.unstubAllEnvs());

describe('archive migration inventory', () => {
  it('reports conflicting statuses and extras without merging or promoting grants', () => {
    const grants = [
      { userId: 'one', catalogId: 'a', role: 'listener', extraPermissions: [], status: 'ACTIVE' },
      { userId: 'one', catalogId: 'b', role: 'listener', extraPermissions: ['read_transcripts'], status: 'REVOKED' },
    ];
    const conflicts = findArchiveGrantConflicts(grants, (row) => row.userId);
    expect(conflicts).toEqual([{ subject: 'one', grants, permissionsDiffer: true }]);
    expect(grants[0].extraPermissions).toEqual([]);
  });

  it('inventories retained sources, standalone invitations, missing access and active jobs in a read-only snapshot', async () => {
    vi.clearAllMocks();
    vi.stubEnv('BESEDY_ARCHIVE_ID', '20251225_120000');
    mocks.tx.workflowGroup.findMany.mockResolvedValue([
      { id: '20251225_120000', isActive: true, _count: { catalogEvents: 2 } },
      { id: '20260101_120000', isActive: false, _count: { transcriptWorkspaces: 1 } },
    ]);
    mocks.tx.catalogAccess.findMany.mockResolvedValue([]);
    mocks.tx.pendingCatalogGrant.findMany.mockResolvedValue([]);
    mocks.tx.portalAdmission.findMany.mockResolvedValue([{ email: 'pending@example.test', source: 'STANDALONE' }]);
    mocks.tx.user.findMany.mockResolvedValue([{ id: 'existing-user' }]);
    mocks.tx.recordingIntake.findMany.mockResolvedValue([{ id: 'queued', workflowGroupId: '20260101_120000', status: 'QUEUED' }]);
    mocks.tx.transcriptPublication.groupBy.mockResolvedValue([]);
    mocks.tx.transcriptPublication.findMany.mockResolvedValue([]);
    mocks.tx.transcriptWorkspace.findMany.mockResolvedValue([]);
    const report = await inspectArchiveMigration();
    expect(report.groups).toHaveLength(2);
    expect(report.standaloneInvitations).toEqual([{ email: 'pending@example.test', source: 'STANDALONE' }]);
    expect(report.usersWithoutArchiveAccess).toEqual([{ id: 'existing-user' }]);
    expect(report.blockers).toHaveLength(4);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
    expect(mocks.tx.$executeRaw.mock.calls[0][0].join('')).toBe('SET TRANSACTION READ ONLY');
    expect(mocks.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.workflowGroup.findMany.mock.invocationCallOrder[0]);
  });

  it('blocks cutover while a publication or search withdrawal awaits its index callback', async () => {
    vi.clearAllMocks();
    vi.stubEnv('BESEDY_ARCHIVE_ID', '20251225_120000');
    mocks.tx.workflowGroup.findMany.mockResolvedValue([{ id: '20251225_120000', isActive: true, _count: {} }]);
    mocks.tx.catalogAccess.findMany.mockResolvedValue([]);
    mocks.tx.pendingCatalogGrant.findMany.mockResolvedValue([]);
    mocks.tx.portalAdmission.findMany.mockResolvedValue([]);
    mocks.tx.user.findMany.mockResolvedValue([]);
    mocks.tx.recordingIntake.findMany.mockResolvedValue([]);
    mocks.tx.transcriptPublication.groupBy.mockResolvedValue([]);
    mocks.tx.transcriptPublication.findMany.mockResolvedValue([{ id: 'publication', status: 'ACTIVATING', indexJobId: 'pending-job' }]);
    mocks.tx.transcriptWorkspace.findMany.mockResolvedValue([{ id: 'workspace', searchWithdrawalId: 'intent', searchWithdrawalJobId: null }]);
    const report = await inspectArchiveMigration();
    expect(report.blockers).toEqual(['Finish or explicitly resolve publication and withdrawal indexing before cutover']);
    expect(report.publicationOperations).toHaveLength(1);
    expect(report.searchWithdrawals).toHaveLength(1);
    expect(mocks.tx.transcriptPublication.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: { in: ['PENDING', 'ACTIVATING', 'ROLLING_BACK'] } },
    }));
  });
});
