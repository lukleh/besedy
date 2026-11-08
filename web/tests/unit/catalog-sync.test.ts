import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';

// Python's duplicates writer is checked against this same fixture.
const duplicatesWithUnknownOriginalCsv = readFileSync(
  path.resolve(__dirname, '../../../contracts/catalog-duplicates-unknown-original.csv'),
  'utf8',
);

// Must equal SOURCE_FINGERPRINT_VERSION (asserted below). A static import of
// source-snapshot would run before the mock functions below are initialized,
// because it loads fs/promises and this file's vi.mock factories are hoisted.
const FINGERPRINT_VERSION = 'v5';

function buildSourceFingerprint(
  content: string,
  version: string = FINGERPRINT_VERSION,
): string {
  return `${version}:sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

const mockAccess = vi.fn();
const mockReadFile = vi.fn();
const mockParse = vi.spyOn(Papa, 'parse');
const mockRewritePath = vi.fn((input: string) => input);

const mockReplaceLostPrimaryRecording = vi.fn();

const mockTx: any = {
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  workflowGroup: {
    findUnique: vi.fn(),
  },
  catalogEntry: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
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
};

const mockPrisma: any = {
  $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) =>
    callback(mockTx),
  ),
  workflowGroup: mockTx.workflowGroup,
  catalogSyncState: {
    findMany: (...args: unknown[]) => mockTx.catalogSyncState.findMany(...args),
    upsert: vi.fn(),
    updateMany: vi.fn(),
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

vi.mock('@/lib/security/path-validation', () => ({
  rewritePath: mockRewritePath,
}));

vi.mock('@/lib/catalog-events/primary-succession', () => ({
  replaceLostPrimaryRecording: mockReplaceLostPrimaryRecording,
}));

vi.mock('@/lib/db', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

describe('catalog-sync', () => {
  const emptyCsv = 'Hash,Full Path,Original Path,Compressed Path\n';
  const emptyCsvFingerprint = buildSourceFingerprint(emptyCsv);

  function csvRows(rows: Array<Record<string, string>>): string {
    const defaults = {
      'Full Path': '/data/original.wav',
      'Original Path': '/data/original.wav',
      'Compressed Path': '/data/audio.webm',
    };
    return Papa.unparse({
      fields: [...new Set(['Hash', ...Object.keys(defaults), ...rows.flatMap(Object.keys)])],
      data: rows.map((row) => ({ ...defaults, ...row })),
    });
  }

  function readCsvRows(rowsByFile: Record<string, Array<Record<string, string>>>) {
    mockReadFile.mockImplementation(async (file: string) => csvRows(rowsByFile[file] ?? []));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('BESEDY_ARCHIVE_ID', '20251222_144441');

    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(emptyCsv);
    mockTx.$executeRaw.mockResolvedValue(1);
    mockTx.catalogEntry.deleteMany.mockResolvedValue({ count: 0 });
    mockTx.catalogEntry.createMany.mockResolvedValue({ count: 0 });
    mockTx.catalogEntry.updateMany.mockResolvedValue({ count: 0 });
    mockTx.catalogEntry.count.mockResolvedValue(0);
    mockTx.catalogSyncState.upsert.mockResolvedValue({});
    mockPrisma.catalogSyncState.upsert.mockReset().mockResolvedValue({});
    mockPrisma.catalogSyncState.updateMany.mockReset().mockResolvedValue({ count: 0 });
    mockTx.catalogDuplicate.deleteMany.mockResolvedValue({ count: 0 });
    mockTx.catalogDuplicate.createMany.mockResolvedValue({ count: 0 });
    mockTx.catalogDuplicate.groupBy.mockResolvedValue([]);
    mockTx.$queryRaw.mockResolvedValue([]);
  });

  it('uses tx-scoped advisory lock and skips sources whose bytes are unchanged', async () => {
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
    });

    // Base sources unchanged; the optional duplicates source is already
    // persisted as missing.
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
    ]);

    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('skipped');
    expect(result.changedSources).toEqual([]);
    expect(result.rowCounts).toEqual({});

    // Lock is transaction-scoped and acquired on the tx handle, after the
    // files were read and hashed outside the transaction.
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockReadFile.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mockTx.$executeRaw.mock.invocationCallOrder[0],
    );
    expect(mockTx.catalogSyncState.upsert).not.toHaveBeenCalled();
    // Required sources are hashed on every reconciliation, but unchanged bytes
    // are not parsed or written.
    expect(mockParse).not.toHaveBeenCalled();
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it('recaptures files when another sync commits while hashing', async () => {
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
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
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
    expect(mockReadFile).toHaveBeenCalledTimes(4);
    expect(mockTx.catalogSyncState.upsert).not.toHaveBeenCalled();
  });

  it('does not mark sources as failed when snapshot retries are exhausted', async () => {
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
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

  it('runs orphan event-recording cleanup after metadata/archived sync success and repairs events that lost their primary', async () => {
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
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

    const promotedHash = 'c'.repeat(64);
    mockTx.$queryRaw
      // Events with orphaned assignments.
      .mockResolvedValueOnce([{ eventId: 7 }, { eventId: 8 }, { eventId: 9 }])
      // Row locks.
      .mockResolvedValueOnce([])
      // Deleted assignments: events 7 and 8 lost their primary.
      .mockResolvedValueOnce([
        { eventId: 7, isPrimary: true },
        { eventId: 8, isPrimary: true },
        { eventId: 9, isPrimary: false },
      ]);
    mockReplaceLostPrimaryRecording.mockImplementation(
      async (_tx: unknown, _groupId: string, eventId: number) =>
        eventId === 7
          ? { kind: 'promoted', audioHash: promotedHash }
          : { kind: 'unreleased' },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const { syncCatalogGroup } = await import('@/lib/catalog-sync');
      const result = await syncCatalogGroup('20251222_144441');

      expect(result.status).toBe('success');
      expect(result.changedSources).toEqual(['metadata', 'archived']);
      expect(mockTx.$queryRaw).toHaveBeenCalledTimes(3);
      const [selectSql, lockSql, deleteSql] = mockTx.$queryRaw.mock.calls.map(
        (call: [TemplateStringsArray]) => call[0].join('?'),
      );
      expect(selectSql).toContain('FROM catalog_event_recording');
      expect(lockSql).toContain('FOR UPDATE');
      expect(deleteSql).toContain('DELETE FROM catalog_event_recording');
      expect(mockReplaceLostPrimaryRecording).toHaveBeenCalledTimes(2);
      expect(mockReplaceLostPrimaryRecording).toHaveBeenCalledWith(
        mockTx,
        '20251222_144441',
        7,
      );
      expect(mockReplaceLostPrimaryRecording).toHaveBeenCalledWith(
        mockTx,
        '20251222_144441',
        8,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Deleted 3 event-recording rows'),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`7 -> ${promotedHash}`),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('without a playable recording in 20251222_144441: 8'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['recovered', 'cleanup-failed', 'newer-failure'])('recovers unchanged known-good source status safely (%s)', async (outcome) => {
    type State = {
      sourceKey: string; filePath: string; fingerprint: string; rowCount: number;
      status: 'SUCCESS' | 'ERROR'; syncedAt: Date; lastSuccessfulAt: Date | null; lastError: string | null;
    };
    const states = new Map<string, State>();
    const groupId = '20251222_144441';
    const hash = 'a'.repeat(64);
    let broken = false;
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: groupId, isActive: true, metadataCatalogPath: '/data/meta.csv', archivedCatalogPath: '/data/archived.csv', duplicatesCatalogPath: null,
    });
    mockTx.catalogSyncState.findMany.mockImplementation(async () => [...states.values()]);
    mockReadFile.mockImplementation(async (file: string) => file === '/data/meta.csv'
      ? `Hash,Full Path\n${hash},${broken ? '' : '/source.wav'}\n`
      : `Hash,Original Path,Compressed Path\n${hash},/source.wav,/audio.webm\n`);
    mockTx.catalogSyncState.upsert.mockImplementation(async ({ create, update }: { create: State; update: Partial<State> }) => {
      const next = { ...states.get(create.sourceKey), ...create, ...update };
      states.set(create.sourceKey, next);
      return next;
    });
    mockPrisma.catalogSyncState.upsert.mockImplementation(async ({ where, update }: {
      where: { workflowGroupId_sourceKey: { sourceKey: string } }; update: Partial<State>;
    }) => {
      const key = where.workflowGroupId_sourceKey.sourceKey;
      const next = { ...states.get(key)!, ...update };
      states.set(key, next);
      return next;
    });
    mockPrisma.catalogSyncState.updateMany.mockImplementation(async ({ where, data }: {
      where: { OR: Array<Pick<State, 'sourceKey' | 'filePath' | 'fingerprint' | 'syncedAt' | 'status'>> };
      data: Partial<State>;
    }) => {
      if (outcome === 'newer-failure') {
        const previous = states.get('metadata')!;
        states.set('metadata', { ...previous, syncedAt: new Date(previous.syncedAt.getTime() + 1), lastError: 'newer failure' });
      }
      let count = 0;
      for (const expected of where.OR) {
        const previous = states.get(expected.sourceKey)!;
        if (previous.status === expected.status && previous.fingerprint === expected.fingerprint &&
            previous.filePath === expected.filePath && previous.syncedAt.getTime() === expected.syncedAt.getTime()) {
          states.set(expected.sourceKey, { ...previous, ...data });
          count++;
        }
      }
      return { count };
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { syncCatalogGroup } = await import('@/lib/catalog-sync');
      expect((await syncCatalogGroup(groupId)).status).toBe('success');
      const lastSuccess = states.get('metadata')!.lastSuccessfulAt;
      expect(lastSuccess).toBeInstanceOf(Date);
      broken = true;
      expect((await syncCatalogGroup(groupId)).status).toBe('error');
      expect(states.get('metadata')).toMatchObject({ status: 'ERROR', lastSuccessfulAt: lastSuccess });
      broken = false;
      mockParse.mockClear();
      mockTx.catalogEntry.createMany.mockClear();
      if (outcome === 'cleanup-failed') mockTx.$queryRaw.mockRejectedValueOnce(new Error('cleanup failed'));

      const recovered = await syncCatalogGroup(groupId);

      expect(recovered.status).toBe(outcome === 'cleanup-failed' ? 'error' : 'skipped');
      expect(mockParse).not.toHaveBeenCalled();
      expect(mockTx.catalogEntry.createMany).not.toHaveBeenCalled();
      expect(states.get('metadata')!.lastSuccessfulAt).toBe(lastSuccess);
      if (outcome === 'recovered') expect(states.get('metadata')).toMatchObject({ status: 'SUCCESS', lastError: null });
      if (outcome === 'cleanup-failed') {
        expect(mockPrisma.catalogSyncState.updateMany).not.toHaveBeenCalled();
        expect(states.get('metadata')!.status).toBe('ERROR');
      }
      if (outcome === 'newer-failure') expect(states.get('metadata')).toMatchObject({ status: 'ERROR', lastError: 'newer failure' });
    } finally {
      log.mockRestore();
    }
  });

  it('reports a cleanup failure and repairs the orphan on an unchanged retry', async () => {
    setupBaseChangedWithBaseline(0);
    parseBaseRows(0);
    const states = new Map<string, Record<string, unknown>>();
    mockTx.catalogSyncState.upsert.mockImplementation(async ({ create }: any) => {
      states.set(create.sourceKey, create);
      return create;
    });
    mockTx.$queryRaw.mockRejectedValueOnce(new Error('temporary database failure'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const { syncCatalogGroup } = await import('@/lib/catalog-sync');
      const first = await syncCatalogGroup('20251222_144441');
      expect(first.status).toBe('error');
      expect(first.error).toContain('Orphan cleanup failed');
      expect(first.error).toContain('temporary database failure');
      expect(states.size).toBe(2);

      // Source generations were committed before cleanup failed. No CSV change
      // or force option should be needed to retry the remaining work.
      states.set('duplicates', {
        sourceKey: 'duplicates', filePath: '', fingerprint: '<missing>', rowCount: 0,
      });
      mockTx.catalogSyncState.findMany.mockResolvedValue([...states.values()]);
      mockTx.$queryRaw
        .mockResolvedValueOnce([{ eventId: 7 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ eventId: 7, isPrimary: true }]);
      mockReplaceLostPrimaryRecording.mockResolvedValue({ kind: 'unreleased' });
      mockParse.mockClear();
      mockTx.catalogSyncState.upsert.mockClear();

      const retry = await syncCatalogGroup('20251222_144441');

      expect(retry.status).toBe('skipped');
      expect(mockParse).not.toHaveBeenCalled();
      expect(mockTx.catalogSyncState.upsert).not.toHaveBeenCalled();
      expect(mockReplaceLostPrimaryRecording).toHaveBeenCalledWith(mockTx, '20251222_144441', 7);
    } finally {
      errorLog.mockRestore();
      warnLog.mockRestore();
    }
  });

  it('stores the AAC copy path from the archived catalog, or null', async () => {
    const withCopy = 'a'.repeat(64);
    const blankCopy = 'b'.repeat(64);
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
    });
    // Every source has a stale fingerprint, so all of them are rebuilt.
    mockTx.catalogSyncState.findMany.mockResolvedValue([
      { sourceKey: 'metadata', filePath: '/data/meta.csv', fingerprint: 'old' },
      { sourceKey: 'archived', filePath: '/data/archived.csv', fingerprint: 'old' },
      { sourceKey: 'duplicates', filePath: '', fingerprint: '<missing>' },
    ]);
    const rowsByFile: Record<string, Array<Record<string, string>>> = {
      '/data/meta.csv': [withCopy, blankCopy].map((hash) => ({ Hash: hash })),
      '/data/archived.csv': [
        {
          Hash: withCopy,
          'Compressed Path': '/data/audio/a_aaaaaaaa.webm',
          'Compressed AAC Path': '/data/audio/a_aaaaaaaa.m4a',
          'Compressed AAC Size (bytes)': '1234',
          'Compressed AAC Bitrate (kbps)': '68',
        },
        {
          Hash: blankCopy,
          'Compressed Path': '/data/audio/b_bbbbbbbb.webm',
          'Compressed AAC Path': '  ',
        },
      ],
    };
    readCsvRows(rowsByFile);

    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('success');
    const entries = mockTx.catalogEntry.createMany.mock.calls[0][0].data;
    const entryPaths = Object.fromEntries(
      entries.map((row: { audioHash: string; compressedAacPath: string | null }) => [
        row.audioHash,
        row.compressedAacPath,
      ]),
    );
    expect(entryPaths).toEqual({
      [withCopy]: '/data/audio/a_aaaaaaaa.m4a',
      [blankCopy]: null,
    });
    const withCopyEntry = entries.find(
      (row: { audioHash: string }) => row.audioHash === withCopy,
    );
    expect(withCopyEntry.sourceArchivedPayload).toMatchObject({
      compressedAacPath: '/data/audio/a_aaaaaaaa.m4a',
      compressedAacSizeBytes: '1234',
      compressedAacBitrateKbps: '68',
    });
  });

  it('rebuilds unchanged sources once after the fingerprint version changes', async () => {
    // A manifest that gained a column while the previous release was running
    // was synced then, so its bytes match what is stored. Only the version
    // prefix tells the new release to read it again.
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
    });
    mockTx.catalogSyncState.findMany.mockResolvedValue([
      { sourceKey: 'metadata', filePath: '/data/meta.csv', fingerprint: buildSourceFingerprint(emptyCsv, 'v3') },
      { sourceKey: 'archived', filePath: '/data/archived.csv', fingerprint: buildSourceFingerprint(emptyCsv, 'v3') },
      { sourceKey: 'duplicates', filePath: '', fingerprint: '<missing>' },
    ]);
    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    const result = await syncCatalogGroup('20251222_144441');

    const { SOURCE_FINGERPRINT_VERSION } = await import('@/lib/catalog-sync/source-snapshot');
    expect(SOURCE_FINGERPRINT_VERSION).toBe(FINGERPRINT_VERSION);
    expect(result.status).toBe('success');
    expect(result.changedSources).toEqual(['metadata', 'archived']);
  });

  it('detects source changes from bytes even when paths and file metadata are unchanged', async () => {
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
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
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
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
      Hash: i.toString(16).padStart(64, '0'),
    }));
    mockReadFile.mockResolvedValue(csvRows(rows));
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

  it.each([
    ['metadata', 'Hash,Full Path\n' + 'a'.repeat(64) + ',"unfinished', 'MissingQuotes'],
    ['metadata', 'Hash,Full Path\n' + 'a'.repeat(64) + ',/source.wav,extra', 'TooManyFields'],
    ['metadata', 'Hash,Full Path,title\n' + 'a'.repeat(64) + ',/source.wav', 'TooFewFields'],
    ['metadata', 'Hash,Hash,Full Path\n', 'duplicate column names'],
    ['metadata', 'Hash, hash ,Full Path\n', 'duplicate column names'],
    ['metadata', 'Hash,,Full Path\n', 'blank column name'],
    ['metadata', 'Full Path\n/source.wav', 'missing required columns: Hash'],
    ['metadata', 'Hash\n' + 'a'.repeat(64), 'missing required columns: Full Path'],
    ['metadata', 'Hash,Full Path\n,/source.wav', '64-character hexadecimal Hash'],
    ['metadata', 'Hash,Full Path\nnot-a-hash,/source.wav', '64-character hexadecimal Hash'],
    ['metadata', 'Hash,Full Path\n' + 'g'.repeat(64) + ',/source.wav', '64-character hexadecimal Hash'],
    ['metadata', 'Hash,Full Path\n' + 'a'.repeat(64) + ',  ', 'blank Full Path'],
    ['archived', 'Hash,Original Path\n', 'missing required columns: Compressed Path'],
    ['archived', 'Hash,Original Path,Compressed Path\n' + 'a'.repeat(64) + ',,/audio.webm', 'blank Original Path'],
    ['archived', 'Hash,Original Path,Compressed Path\n' + 'a'.repeat(64) + ',/source.wav,', 'blank Compressed Path'],
    ['duplicates', 'Hash,Original Path\n', 'missing required columns: Duplicate Path'],
    ['duplicates', 'Hash,Duplicate Path\n' + 'a'.repeat(64) + ',/duplicate.wav', 'missing required columns: Original Path'],
    ['duplicates', 'Hash,Original Path,Duplicate Path\n,/source.wav,/duplicate.wav', '64-character hexadecimal Hash'],
    ['duplicates', 'Hash,Original Path,Duplicate Path\n' + 'a'.repeat(64) + ',/source.wav,', 'blank Duplicate Path'],
    ['duplicates', 'Hash,Original Path,Duplicate Path\nnot-a-hash,,/duplicate.wav', '64-character hexadecimal Hash'],
    ['duplicates', 'Hash,Original Path,Duplicate Path\n' + 'a'.repeat(64) + ',,', 'blank Duplicate Path'],
    ['metadata', '', 'missing required columns'],
  ])('rejects invalid %s CSV before touching the live projection (%s)', async (kind, content, detail) => {
    setupBaseChangedWithBaseline(100);
    const group = {
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/metadata.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: '/data/duplicates.csv',
    };
    mockTx.workflowGroup.findUnique.mockResolvedValue(group);
    mockReadFile.mockImplementation(async (file: string) =>
      file === `/data/${kind}.csv`
        ? content
        : file === group.duplicatesCatalogPath
          ? 'Hash,Original Path,Duplicate Path\n'
          : emptyCsv,
    );
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { syncCatalogGroup } = await import('@/lib/catalog-sync');
      // The row-count escape hatch must never bypass structural validation.
      const result = await syncCatalogGroup(group.id, { allowRowCountDrop: true });

      expect(result).toMatchObject({
        status: 'error',
        error: expect.stringContaining(`Invalid ${kind} catalog CSV:`),
      });
      expect(result.error).toContain(detail);
      expect(mockTx.catalogEntry.deleteMany).not.toHaveBeenCalled();
      expect(mockTx.catalogEntry.createMany).not.toHaveBeenCalled();
      expect(mockTx.catalogEntry.updateMany).not.toHaveBeenCalled();
      expect(mockTx.catalogDuplicate.deleteMany).not.toHaveBeenCalled();
      expect(mockTx.catalogDuplicate.createMany).not.toHaveBeenCalled();
      expect(mockTx.catalogSyncState.upsert).not.toHaveBeenCalled();
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1); // Advisory lock only.
      expect(mockTx.$queryRaw).not.toHaveBeenCalled(); // No orphan cleanup.
    } finally {
      errorLog.mockRestore();
      warnLog.mockRestore();
    }
  });

  it('keeps header-only sources valid when an empty projection is explicitly allowed', async () => {
    setupBaseChangedWithBaseline(100);
    const { syncCatalogGroup } = await import('@/lib/catalog-sync');

    const result = await syncCatalogGroup('20251222_144441', { allowRowCountDrop: true });

    expect(result.status).toBe('success');
    expect(result.rowCounts).toEqual({ metadata: 0, archived: 0 });
  });

  it('accepts normalized headers, quoted paths and missing optional columns', async () => {
    setupBaseChangedWithBaseline(0);
    const hash = 'a'.repeat(64);
    mockReadFile.mockImplementation(async (file: string) =>
      file === '/data/meta.csv'
        ? `\ufeff Hash , FULL PATH \n${hash.toUpperCase()},"/source, recording.wav"\n`
        : `Hash,Original Path,Compressed Path\n${hash},"/source, recording.wav",/audio.webm\n`,
    );
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { syncCatalogGroup } = await import('@/lib/catalog-sync');
      const result = await syncCatalogGroup('20251222_144441');

      expect(result.status).toBe('success');
      expect(result.unrecognizedHashAlgorithmRows).toBe(1);
      expect(mockTx.catalogEntry.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({
          audioHash: hash,
          originalPath: '/source, recording.wav',
          compressedPath: '/audio.webm',
          compressedAacPath: null,
          hasMetadata: true,
          hasArchived: true,
        })],
        skipDuplicates: true,
      });
    } finally {
      warnLog.mockRestore();
    }
  });

  it('rejects duplicate identities after normalizing hash case', async () => {
    setupBaseChangedWithBaseline(0);
    const hash = 'a'.repeat(64);
    readCsvRows({
      '/data/meta.csv': [{ Hash: hash }, { Hash: hash.toUpperCase() }],
    });
    const { syncCatalogGroup } = await import('@/lib/catalog-sync');

    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('error');
    expect(result.error).toContain('Duplicate Hash in metadata catalog');
    expect(mockTx.catalogEntry.deleteMany).not.toHaveBeenCalled();
  });

  it('does not clear duplicate rows when only the duplicates source changed and is invalid', async () => {
    setupBaseChangedWithBaseline(1);
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: '/data/duplicates.csv',
    });
    mockTx.catalogSyncState.findMany.mockResolvedValue([
      { sourceKey: 'metadata', filePath: '/data/meta.csv', fingerprint: emptyCsvFingerprint, rowCount: 1 },
      { sourceKey: 'archived', filePath: '/data/archived.csv', fingerprint: emptyCsvFingerprint, rowCount: 1 },
      { sourceKey: 'duplicates', filePath: '/data/duplicates.csv', fingerprint: 'old', rowCount: 1 },
    ]);
    mockReadFile.mockImplementation(async (file: string) =>
      file === '/data/duplicates.csv'
        ? `Hash,Original Path,Duplicate Path\n${'a'.repeat(64)},/source.wav,\n`
        : emptyCsv,
    );
    const { syncCatalogGroup } = await import('@/lib/catalog-sync');

    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('error');
    expect(result.changedSources).toEqual(['duplicates']);
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(mockTx.catalogDuplicate.deleteMany).not.toHaveBeenCalled();
    expect(mockTx.catalogEntry.updateMany).not.toHaveBeenCalled();
    expect(mockTx.catalogSyncState.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.catalogSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { status: 'ERROR', syncedAt: expect.any(Date), lastError: result.error },
      }),
    );
  });

  it('accepts several duplicate paths for the same recording', async () => {
    setupBaseChangedWithBaseline(0);
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: '/data/duplicates.csv',
    });
    const hash = 'a'.repeat(64);
    readCsvRows({
      '/data/meta.csv': [{ Hash: hash }],
      '/data/archived.csv': [{ Hash: hash }],
      '/data/duplicates.csv': [
        { Hash: hash, 'Duplicate Path': '/copy1.wav' },
        { Hash: hash, 'Duplicate Path': '/copy2.wav' },
      ],
    });
    const { syncCatalogGroup } = await import('@/lib/catalog-sync');

    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('success');
    expect(result.rowCounts).toEqual({ metadata: 1, archived: 1, duplicates: 2 });
    expect(mockTx.catalogDuplicate.createMany.mock.calls[0][0].data).toHaveLength(2);
    expect(mockTx.catalogEntry.createMany.mock.calls[0][0].data[0].duplicateCount).toBe(2);
  });

  it('syncs Python duplicate output while skipping rows whose original is unknown', async () => {
    setupBaseChangedWithBaseline(0);
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: '/data/duplicates.csv',
    });
    const known = 'a'.repeat(64);
    const unknown = 'b'.repeat(64);
    mockReadFile.mockImplementation(async (file: string) =>
      file === '/data/duplicates.csv'
        ? duplicatesWithUnknownOriginalCsv
        : csvRows([{ Hash: known }, { Hash: unknown }]),
    );
    const { syncCatalogGroup } = await import('@/lib/catalog-sync');

    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('success');
    expect(result.rowCounts).toEqual({ metadata: 2, archived: 2, duplicates: 2 });
    expect(mockTx.catalogDuplicate.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ audioHash: known, originalPath: '/source/known.mp3', duplicatePath: '/copies/copy1.mp3' }),
      expect.objectContaining({ audioHash: known, originalPath: '/source/known.mp3', duplicatePath: '/copies/copy2.mp3' }),
    ]);
    expect(mockTx.catalogEntry.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ audioHash: known, duplicateCount: 2 }),
      expect.objectContaining({ audioHash: unknown, duplicateCount: 0 }),
    ]);
    expect(mockTx.catalogSyncState.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: 'SUCCESS', rowCount: 2, lastSuccessfulAt: expect.any(Date) }),
      where: { workflowGroupId_sourceKey: { workflowGroupId: '20251222_144441', sourceKey: 'duplicates' } },
    }));
    for (const [input] of mockTx.catalogSyncState.upsert.mock.calls) {
      expect(input.update.lastSuccessfulAt).toBe(input.update.syncedAt);
      expect(input.create.lastSuccessfulAt).toBe(input.create.syncedAt);
    }
  });

  it('clears projected duplicate counts when the changed source only has unknown originals', async () => {
    setupBaseChangedWithBaseline(1);
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: '/data/duplicates.csv',
    });
    mockTx.catalogSyncState.findMany.mockResolvedValue([
      { sourceKey: 'metadata', filePath: '/data/meta.csv', fingerprint: emptyCsvFingerprint, rowCount: 1 },
      { sourceKey: 'archived', filePath: '/data/archived.csv', fingerprint: emptyCsvFingerprint, rowCount: 1 },
      { sourceKey: 'duplicates', filePath: '/data/duplicates.csv', fingerprint: 'old', rowCount: 1 },
    ]);
    mockReadFile.mockImplementation(async (file: string) =>
      file === '/data/duplicates.csv'
        ? `Hash,Original Path,Duplicate Path\n${'a'.repeat(64)},  ,/duplicate.wav\n`
        : emptyCsv,
    );
    const { syncCatalogGroup } = await import('@/lib/catalog-sync');

    const result = await syncCatalogGroup('20251222_144441');

    expect(result.status).toBe('success');
    expect(result.changedSources).toEqual(['duplicates']);
    expect(result.rowCounts).toEqual({ duplicates: 0 });
    expect(mockTx.catalogDuplicate.deleteMany).toHaveBeenCalledWith({ where: { workflowGroupId: '20251222_144441' } });
    expect(mockTx.catalogDuplicate.createMany).not.toHaveBeenCalled();
    expect(mockTx.catalogEntry.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { workflowGroupId: '20251222_144441' },
      data: { duplicateCount: 0 },
    });
  });

  it('syncs rows with a missing or unknown hash algorithm and reports how many', async () => {
    const known = 'a'.repeat(64);
    const unknown = 'b'.repeat(64);
    const missing = 'c'.repeat(64);
    mockTx.workflowGroup.findUnique.mockResolvedValue({
      id: '20251222_144441', isActive: true,
      metadataCatalogPath: '/data/meta.csv',
      archivedCatalogPath: '/data/archived.csv',
      duplicatesCatalogPath: null,
      variants: [],
    });
    mockTx.catalogSyncState.findMany.mockResolvedValue([
      { sourceKey: 'metadata', filePath: '/data/meta.csv', fingerprint: 'old' },
      { sourceKey: 'archived', filePath: '/data/archived.csv', fingerprint: 'old' },
      { sourceKey: 'duplicates', filePath: '', fingerprint: '<missing>' },
    ]);
    const rowsByFile: Record<string, Array<Record<string, string>>> = {
      '/data/meta.csv': [
        { Hash: known, 'Hash Algorithm': 'pcm-s16le-16000hz-mono-sha256-v1' },
        { Hash: unknown, 'Hash Algorithm': 'sha256-of-file' },
        { Hash: missing },
      ],
      '/data/archived.csv': [known, unknown, missing].map((hash) => ({
        Hash: hash,
        'Compressed Path': `/data/audio/${hash.slice(0, 8)}.webm`,
      })),
    };
    readCsvRows(rowsByFile);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const { syncCatalogGroup } = await import('@/lib/catalog-sync');
      const result = await syncCatalogGroup('20251222_144441');

      expect(result.status).toBe('success');
      expect(result.unrecognizedHashAlgorithmRows).toBe(2);
      // Nothing is dropped.
      expect(mockTx.catalogEntry.createMany.mock.calls[0][0].data).toHaveLength(3);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('2 metadata rows have a missing or unknown Hash Algorithm'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
