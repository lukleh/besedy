import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

function buildSourceFingerprint(content: string): string {
  return `v3:sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

const mockAccess = vi.fn();
const mockReadFile = vi.fn();
const mockParse = vi.fn();
const mockRewritePath = vi.fn((input: string) => input);

const mockTx: any = {
  $executeRaw: vi.fn(),
  workflowGroup: {
    findUnique: vi.fn(),
  },
  catalogEntry: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  catalogSyncState: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  catalogDuplicate: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    groupBy: vi.fn(),
  },
  catalogListeningEntry: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
};

const mockPrisma: any = {
  $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) =>
    callback(mockTx),
  ),
  $executeRaw: vi.fn(),
  workflowGroup: mockTx.workflowGroup,
  catalogSyncState: {
    findMany: (...args: unknown[]) => mockTx.catalogSyncState.findMany(...args),
    upsert: vi.fn(),
  },
};

vi.mock('fs/promises', () => ({
  default: {
    access: mockAccess,
    readFile: mockReadFile,
  },
  access: mockAccess,
  readFile: mockReadFile,
}));

vi.mock('papaparse', () => ({
  default: {
    parse: mockParse,
  },
}));

vi.mock('@/lib/security/path-validation', () => ({
  rewritePath: mockRewritePath,
}));

vi.mock('@/lib/db', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

describe('catalog-sync', () => {
  const emptyCsv = 'Hash\n';
  const emptyCsvFingerprint = buildSourceFingerprint(emptyCsv);

  beforeEach(() => {
    vi.clearAllMocks();

    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(emptyCsv);
    mockTx.$executeRaw.mockResolvedValue(1);
    mockTx.catalogEntry.deleteMany.mockResolvedValue({ count: 0 });
    mockTx.catalogEntry.createMany.mockResolvedValue({ count: 0 });
    mockTx.catalogEntry.updateMany.mockResolvedValue({ count: 0 });
    mockTx.catalogEntry.findMany.mockResolvedValue([]);
    mockTx.catalogEntry.count.mockResolvedValue(0);
    mockTx.catalogSyncState.upsert.mockResolvedValue({});
    mockTx.catalogDuplicate.deleteMany.mockResolvedValue({ count: 0 });
    mockTx.catalogDuplicate.createMany.mockResolvedValue({ count: 0 });
    mockTx.catalogListeningEntry.deleteMany.mockResolvedValue({ count: 1 });
    mockTx.catalogListeningEntry.createMany.mockResolvedValue({ count: 0 });
    mockTx.catalogDuplicate.groupBy.mockResolvedValue([]);
    mockPrisma.$executeRaw.mockResolvedValue(0);
  });

  it('uses tx-scoped advisory lock and purges stale listening rows when variant path is removed', async () => {
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441',
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
      variants: [
        {
          variant: 'enhanced',
          listeningArchivedCatalogPath: null,
        },
      ],
    });

    // Base sources unchanged, but listening source existed before and is now missing.
    mockTx.catalogSyncState.findMany.mockResolvedValue([
      {
        sourceKey: 'metadata',
        filePath: '/data/meta.csv',
        fingerprint: emptyCsvFingerprint,
      },
      {
        sourceKey: 'archived',
        filePath: '/data/archived.csv',
        fingerprint: emptyCsvFingerprint,
      },
      {
        sourceKey: 'duplicates',
        filePath: '',
        fingerprint: '<missing>',
      },
      {
        sourceKey: 'listening:enhanced',
        filePath: '/data/old-listening.csv',
        fingerprint: '200:2000',
      },
    ]);

    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('success');
    expect(result.changedSources).toEqual(['listening:enhanced']);
    expect(result.rowCounts).toEqual({ 'listening:enhanced': 0 });

    // Lock is now transaction-scoped and acquired on tx handle.
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    expect(mockReadFile.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mockTx.$executeRaw.mock.invocationCallOrder[0],
    );

    expect(mockTx.catalogListeningEntry.deleteMany).toHaveBeenCalledWith({
      where: {
        workflowGroupId: '20251222_144441',
        variant: 'enhanced',
      },
    });
    expect(mockTx.catalogListeningEntry.createMany).not.toHaveBeenCalled();

    expect(mockTx.catalogSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workflowGroupId_sourceKey: {
            workflowGroupId: '20251222_144441',
            sourceKey: 'listening:enhanced',
          },
        },
        update: expect.objectContaining({
          status: 'SUCCESS',
          rowCount: 0,
          filePath: '',
          fingerprint: '<missing>',
        }),
      }),
    );

    // Required sources are hashed on every reconciliation, but unchanged bytes
    // are not parsed or written.
    expect(mockParse).not.toHaveBeenCalled();
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it('stabilizes to skipped when optional source is already in missing state', async () => {
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441',
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
      variants: [
        {
          variant: 'enhanced',
          listeningArchivedCatalogPath: null,
        },
      ],
    });

    // Base sources unchanged; listening source already persisted as missing.
    mockTx.catalogSyncState.findMany.mockResolvedValue([
      {
        sourceKey: 'metadata',
        filePath: '/data/meta.csv',
        fingerprint: emptyCsvFingerprint,
      },
      {
        sourceKey: 'archived',
        filePath: '/data/archived.csv',
        fingerprint: emptyCsvFingerprint,
      },
      {
        sourceKey: 'duplicates',
        filePath: '',
        fingerprint: '<missing>',
      },
      {
        sourceKey: 'listening:enhanced',
        filePath: '',
        fingerprint: '<missing>',
      },
    ]);

    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('skipped');
    expect(result.changedSources).toEqual([]);
    expect(result.rowCounts).toEqual({});

    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockTx.catalogListeningEntry.deleteMany).not.toHaveBeenCalled();
    expect(mockTx.catalogListeningEntry.createMany).not.toHaveBeenCalled();
    expect(mockTx.catalogSyncState.upsert).not.toHaveBeenCalled();
    expect(mockParse).not.toHaveBeenCalled();
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it('recaptures files when another sync commits while hashing', async () => {
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441',
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
      variants: [],
    });

    const oldStates = [
      {
        sourceKey: 'metadata',
        filePath: '/data/meta.csv',
        fingerprint: 'v2:old',
        rowCount: 0,
      },
      {
        sourceKey: 'archived',
        filePath: '/data/archived.csv',
        fingerprint: 'v2:old',
        rowCount: 0,
      },
      {
        sourceKey: 'duplicates',
        filePath: '',
        fingerprint: '<missing>',
        rowCount: 0,
      },
    ];
    const currentStates = oldStates.map((state) =>
      state.sourceKey === 'duplicates'
        ? state
        : { ...state, fingerprint: emptyCsvFingerprint },
    );
    mockTx.catalogSyncState.findMany
      .mockResolvedValueOnce(oldStates)
      .mockResolvedValue(currentStates);

    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('skipped');
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    expect(mockReadFile).toHaveBeenCalledTimes(4);
    expect(mockTx.catalogSyncState.upsert).not.toHaveBeenCalled();
  });

  it('does not mark sources as failed when snapshot retries are exhausted', async () => {
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441',
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
      variants: [],
    });

    const statesFor = (fingerprint: string) => [
      {
        sourceKey: 'metadata',
        filePath: '/data/meta.csv',
        fingerprint,
        rowCount: 0,
      },
      {
        sourceKey: 'archived',
        filePath: '/data/archived.csv',
        fingerprint,
        rowCount: 0,
      },
      {
        sourceKey: 'duplicates',
        filePath: '',
        fingerprint: '<missing>',
        rowCount: 0,
      },
    ];
    mockTx.catalogSyncState.findMany
      .mockResolvedValueOnce(statesFor('v2:initial'))
      .mockResolvedValueOnce(statesFor('v3:concurrent-1'))
      .mockResolvedValueOnce(statesFor('v3:concurrent-1'))
      .mockResolvedValueOnce(statesFor('v3:concurrent-2'));

    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    const result = await syncCatalogGroup('20251222_144441');

    expect(result).toMatchObject({
      status: 'error',
      changedSources: [],
      error: expect.stringContaining('state changed while sync was reading'),
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    expect(mockTx.catalogSyncState.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.catalogSyncState.upsert).not.toHaveBeenCalled();
  });

  it('runs orphan event-recording cleanup after metadata/archived sync success', async () => {
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441',
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
      variants: [],
    });

    // Changed base sources trigger rebuild path.
    mockTx.catalogSyncState.findMany.mockResolvedValue([
      {
        sourceKey: 'metadata',
        filePath: '/data/meta.csv',
        fingerprint: '90:900',
      },
      {
        sourceKey: 'archived',
        filePath: '/data/archived.csv',
        fingerprint: '90:900',
      },
      {
        sourceKey: 'duplicates',
        filePath: '',
        fingerprint: '<missing>',
      },
    ]);

    mockReadFile.mockResolvedValue('Hash\n');
    mockParse.mockImplementation(
      (
        _content,
        options: { complete: (result: { data: any[]; errors: any[] }) => void },
      ) => {
        options.complete({ data: [], errors: [] });
      },
    );

    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('success');
    expect(result.changedSources).toEqual(['metadata', 'archived']);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('detects source changes from bytes even when paths and file metadata are unchanged', async () => {
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441',
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
      variants: [],
    });

    mockTx.catalogSyncState.findMany.mockResolvedValue([
      {
        sourceKey: 'metadata',
        filePath: '/data/meta.csv',
        fingerprint: buildSourceFingerprint('Hash\nold-meta'),
      },
      {
        sourceKey: 'archived',
        filePath: '/data/archived.csv',
        fingerprint: buildSourceFingerprint('Hash\nold-archive'),
      },
      {
        sourceKey: 'duplicates',
        filePath: '',
        fingerprint: '<missing>',
      },
    ]);

    mockParse.mockImplementation(
      (
        _content,
        options: { complete: (result: { data: any[]; errors: any[] }) => void },
      ) => {
        options.complete({ data: [], errors: [] });
      },
    );

    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('success');
    expect(result.changedSources).toEqual(['metadata', 'archived']);
    expect(mockTx.catalogSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workflowGroupId_sourceKey: {
            workflowGroupId: '20251222_144441',
            sourceKey: 'metadata',
          },
        },
        update: expect.objectContaining({
          fingerprint: emptyCsvFingerprint,
        }),
      }),
    );
  });

  function setupBaseChangedWithBaseline(rowCount: number) {
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441',
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
      variants: [],
    });
    // Stored fingerprints differ from the current file, so base sources change.
    // rowCount records the previously-synced baseline the drop guard compares to.
    mockTx.catalogSyncState.findMany.mockResolvedValue([
      {
        sourceKey: 'metadata',
        filePath: '/data/meta.csv',
        fingerprint: buildSourceFingerprint('old metadata'),
        rowCount,
      },
      {
        sourceKey: 'archived',
        filePath: '/data/archived.csv',
        fingerprint: buildSourceFingerprint('old archive'),
        rowCount,
      },
      {
        sourceKey: 'duplicates',
        filePath: '',
        fingerprint: '<missing>',
        rowCount: 0,
      },
    ]);
  }

  function parseBaseRows(count: number) {
    const rows = Array.from({ length: count }, (_, i) => ({
      Hash: `hash-${i}`,
    }));
    mockReadFile.mockResolvedValue('Hash\n');
    mockParse.mockImplementation(
      (
        _content,
        options: { complete: (result: { data: any[]; errors: any[] }) => void },
      ) => {
        options.complete({ data: rows, errors: [] });
      },
    );
  }

  it('refuses to wipe a populated catalog when the source CSV is empty', async () => {
    setupBaseChangedWithBaseline(100);
    parseBaseRows(0);

    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/source CSV is empty/i);
    expect(mockTx.catalogEntry.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a base sync that drops the row count below half the baseline', async () => {
    setupBaseChangedWithBaseline(100);
    parseBaseRows(10);

    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/row count dropped from 100 to 10/i);
    expect(mockTx.catalogEntry.deleteMany).not.toHaveBeenCalled();
  });

  it('allows a large drop when allowRowCountDrop is set', async () => {
    setupBaseChangedWithBaseline(100);
    parseBaseRows(10);

    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    const result = await syncCatalogGroup('20251222_144441', {
      allowRowCountDrop: true,
    });

    expect(result.status).toBe('success');
  });
});
