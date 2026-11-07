import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ArchiveConfigurationError, ArchiveScopeError, assertArchiveCatalogId,
  getConfiguredArchive, getConfiguredArchiveId, requireArchive, requireArchiveId,
} from '@/lib/archive';
import { handlePrismaError } from '@/lib/api/errors';
import prisma from '@/lib/db';

vi.mock('@/lib/db', () => ({ default: { workflowGroup: { findUnique: vi.fn() } } }));
const ID = '20251225_120000';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BESEDY_ARCHIVE_ID', '');
  vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe('archive deployment binding', () => {
  it('retains only the transitional unset path and never auto-selects a source', async () => {
    expect(getConfiguredArchiveId()).toBeNull();
    expect(await getConfiguredArchive()).toBeNull();
    await assertArchiveCatalogId('another-source');
    expect(prisma.workflowGroup.findUnique).not.toHaveBeenCalled();
    expect(() => requireArchiveId()).toThrow(ArchiveConfigurationError);
    await expect(requireArchive()).rejects.toThrow('BESEDY_ARCHIVE_ID is required');
  });

  it.each(['newest', '../20251225_120000', '20251225_120000/extra'])('refuses malformed binding %s', async (value) => {
    vi.stubEnv('BESEDY_ARCHIVE_ID', value);
    await expect(getConfiguredArchive()).rejects.toThrow(ArchiveConfigurationError);
    expect(prisma.workflowGroup.findUnique).not.toHaveBeenCalled();
  });

  it.each([null, { id: ID, label: 'Archive', isActive: false }])('refuses missing or inactive source', async (group) => {
    vi.stubEnv('BESEDY_ARCHIVE_ID', ID);
    vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue(group as never);
    await expect(requireArchive()).rejects.toThrow('existing active source');
    await expect(assertArchiveCatalogId(ID)).rejects.toThrow(ArchiveConfigurationError);
  });

  it('uses exactly the active configured source, with no default/preference query', async () => {
    vi.stubEnv('BESEDY_ARCHIVE_ID', ` ${ID} `);
    vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue({ id: ID, label: 'Archive', isActive: true } as never);
    expect(await requireArchive()).toEqual({ id: ID, label: 'Archive' });
    expect(prisma.workflowGroup.findUnique).toHaveBeenCalledWith({
      where: { id: ID }, select: { id: true, label: true, isActive: true },
    });
    await expect(assertArchiveCatalogId('20261107_120000')).rejects.toThrow(ArchiveScopeError);
    await expect(assertArchiveCatalogId(ID)).resolves.toBeUndefined();
  });

  it('reports configuration unavailability separately from a foreign catalog', () => {
    expect(handlePrismaError(new ArchiveConfigurationError('Invalid archive configuration'), 'catalog', 'fetch').status).toBe(503);
    expect(handlePrismaError(new ArchiveScopeError(), 'catalog', 'fetch').status).toBe(404);
  });
});
