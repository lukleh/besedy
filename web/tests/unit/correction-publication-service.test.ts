import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeIndexSync,
  publishTranscript,
  unpublishTranscript,
} from '@/lib/correction/publication-service';

const mocks = vi.hoisted(() => ({
  prisma: {
    transcriptWorkspace: {
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    transcriptPublication: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
  lockWorkspace: vi.fn(),
  removeIndexPointer: vi.fn(),
  evaluateWorkspace: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ default: mocks.prisma }));
vi.mock('@/lib/correction/workspace-lock', () => ({
  lockWorkspace: mocks.lockWorkspace,
}));
vi.mock('@/lib/correction/storage', async (original) => ({
  ...(await original<typeof import('@/lib/correction/storage')>()),
  removeIndexPointer: mocks.removeIndexPointer,
}));
vi.mock('@/lib/correction/publication-eligibility', () => ({
  evaluateWorkspace: mocks.evaluateWorkspace,
}));
vi.mock('@/lib/correction/guide', () => ({
  getActiveGuideRevisionId: async () => 'guide-1',
}));

const CATALOG_ID = '20260101_000000';
const AUDIO_HASH = 'a'.repeat(64);
const input = {
  catalogId: CATALOG_ID,
  audioHash: AUDIO_HASH,
  userId: 'publisher-1',
};
const completion = {
  catalogId: CATALOG_ID,
  audioHash: AUDIO_HASH,
  operation: 'withdraw' as const,
  operationToken: 'unpublish-1',
  status: 'SUCCEEDED' as const,
  transcriptPath: `/transcripts/faster-whisper/default/${AUDIO_HASH}/transcript.json`,
  transcriptFingerprint: 'machine-fingerprint',
};

interface WorkspaceState {
  id: string;
  status: 'ACTIVE' | 'ARCHIVED';
  readerPublicationId: string | null;
  searchPublicationId: string | null;
  searchWithdrawalId: string | null;
  searchWithdrawalJobId: string | null;
  publications: Array<{ id: string; status: string }>;
}

let workspace: WorkspaceState;

beforeEach(() => {
  vi.resetAllMocks();
  workspace = {
    id: 'workspace-1',
    status: 'ACTIVE',
    readerPublicationId: 'publication-1',
    searchPublicationId: 'publication-1',
    searchWithdrawalId: null,
    searchWithdrawalJobId: null,
    publications: [],
  };
  mocks.prisma.$transaction.mockImplementation(async (operation) =>
    operation(mocks.prisma),
  );
  mocks.prisma.transcriptWorkspace.findFirst.mockImplementation(async () => ({
    ...workspace,
  }));
  mocks.prisma.transcriptWorkspace.findUniqueOrThrow.mockImplementation(
    async () => ({ ...workspace }),
  );
  mocks.prisma.transcriptWorkspace.update.mockImplementation(
    async ({ data }) => {
      Object.assign(workspace, data);
      return { ...workspace };
    },
  );
  mocks.prisma.transcriptWorkspace.updateMany.mockImplementation(
    async ({ where, data }) => {
      if (
        where.searchWithdrawalId !== undefined &&
        where.searchWithdrawalId !== workspace.searchWithdrawalId
      ) {
        return { count: 0 };
      }
      Object.assign(workspace, data);
      return { count: 1 };
    },
  );
  mocks.prisma.transcriptPublication.findFirst.mockResolvedValue(null);
  mocks.removeIndexPointer.mockResolvedValue(undefined);
});

describe('coupled Unpublish', () => {
  it('clears both publication pointers and records intent before removing the index pointer', async () => {
    const indexSync = vi.fn().mockImplementation(async (request) => {
      expect(workspace).toMatchObject({
        readerPublicationId: null,
        searchPublicationId: null,
        searchWithdrawalId: request.operationToken,
      });
      expect(mocks.removeIndexPointer).toHaveBeenCalledWith(
        CATALOG_ID,
        AUDIO_HASH,
      );
      return { jobId: 'job-1' };
    });

    await expect(unpublishTranscript(input, { indexSync })).resolves.toEqual({
      unpublished: true,
      pendingIndexSync: true,
    });
    expect(indexSync).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: CATALOG_ID,
        audioHash: AUDIO_HASH,
        operation: 'withdraw',
        operationToken: expect.any(String),
        requestedById: 'publisher-1',
      }),
    );
    expect(workspace.searchWithdrawalJobId).toBe('job-1');
    expect(mocks.lockWorkspace).toHaveBeenCalledTimes(2);
  });

  it('retracts a legacy search-only publication without exposing it to the reader', async () => {
    workspace.readerPublicationId = null;
    const indexSync = vi.fn().mockResolvedValue({ jobId: 'job-1' });

    await unpublishTranscript(input, { indexSync });

    expect(workspace.readerPublicationId).toBeNull();
    expect(workspace.searchPublicationId).toBeNull();
    expect(indexSync).toHaveBeenCalledOnce();
  });

  it('retries the same durable generation after job submission fails', async () => {
    const indexSync = vi
      .fn()
      .mockRejectedValueOnce(new Error('Worker unavailable'))
      .mockResolvedValueOnce({ jobId: 'retry-job' });

    await expect(
      unpublishTranscript(input, { indexSync }),
    ).rejects.toMatchObject({
      code: 'INDEX_SYNC_UNAVAILABLE',
    });
    const generation = workspace.searchWithdrawalId;
    expect(generation).toEqual(expect.any(String));
    expect(workspace.readerPublicationId).toBeNull();
    expect(workspace.searchPublicationId).toBeNull();

    await unpublishTranscript(input, { indexSync });

    expect(
      indexSync.mock.calls.map(([request]) => request.operationToken),
    ).toEqual([generation, generation]);
    expect(mocks.prisma.transcriptWorkspace.update).toHaveBeenCalledOnce();
    expect(workspace.searchWithdrawalJobId).toBe('retry-job');
  });

  it('makes a completed repeated request a no-op', async () => {
    workspace.readerPublicationId = null;
    workspace.searchPublicationId = null;
    const indexSync = vi.fn();

    await expect(unpublishTranscript(input, { indexSync })).resolves.toEqual({
      unpublished: true,
      pendingIndexSync: false,
    });
    expect(mocks.prisma.transcriptWorkspace.update).not.toHaveBeenCalled();
    expect(mocks.removeIndexPointer).not.toHaveBeenCalled();
    expect(indexSync).not.toHaveBeenCalled();
  });

  it('refuses Unpublish while a publication can still activate', async () => {
    mocks.prisma.transcriptPublication.findFirst.mockResolvedValue({
      id: 'activating-1',
    });
    const indexSync = vi.fn();

    await expect(
      unpublishTranscript(input, { indexSync }),
    ).rejects.toMatchObject({
      code: 'PUBLICATION_IN_FLIGHT',
    });
    expect(workspace.readerPublicationId).toBe('publication-1');
    expect(mocks.removeIndexPointer).not.toHaveBeenCalled();
    expect(indexSync).not.toHaveBeenCalled();
  });

  it('does not remove a newer pointer when a delayed retry loses its generation', async () => {
    workspace.readerPublicationId = null;
    workspace.searchPublicationId = null;
    workspace.searchWithdrawalId = 'unpublish-1';
    mocks.prisma.transcriptWorkspace.findUniqueOrThrow
      .mockResolvedValueOnce({ ...workspace })
      .mockResolvedValueOnce({
        ...workspace,
        readerPublicationId: 'new-publication',
        searchPublicationId: 'new-publication',
        searchWithdrawalId: null,
      });
    const indexSync = vi.fn();

    await expect(
      unpublishTranscript(input, { indexSync }),
    ).resolves.toMatchObject({ pendingIndexSync: false });

    expect(mocks.removeIndexPointer).not.toHaveBeenCalled();
    expect(indexSync).not.toHaveBeenCalled();
  });

  it('does not restore pending state when the job completes before submission returns', async () => {
    const indexSync = vi.fn().mockImplementation(async () => {
      workspace.searchWithdrawalId = null;
      return { jobId: 'already-finished' };
    });

    await expect(
      unpublishTranscript(input, { indexSync }),
    ).resolves.toMatchObject({ pendingIndexSync: false });

    expect(workspace.searchWithdrawalJobId).toBeNull();
  });

  it('rechecks workspace archival under the lock', async () => {
    workspace.status = 'ARCHIVED';

    await expect(
      unpublishTranscript(input, { indexSync: vi.fn() }),
    ).rejects.toMatchObject({
      code: 'WORKSPACE_ARCHIVED',
    });
    expect(mocks.prisma.transcriptWorkspace.update).not.toHaveBeenCalled();
  });
});

describe('unpublish index reports', () => {
  beforeEach(() => {
    workspace.readerPublicationId = null;
    workspace.searchPublicationId = null;
    workspace.searchWithdrawalId = completion.operationToken;
    workspace.searchWithdrawalJobId = 'job-1';
  });

  it('accepts existing withdraw callbacks and clears intent only after machine-source proof', async () => {
    await expect(completeIndexSync(completion)).resolves.toEqual({
      outcome: 'withdrawn',
    });

    expect(workspace.searchWithdrawalId).toBeNull();
    expect(workspace.searchWithdrawalJobId).toBeNull();
    expect(workspace.readerPublicationId).toBeNull();
    expect(workspace.searchPublicationId).toBeNull();
  });

  it('keeps an unsuccessful operation retryable', async () => {
    await expect(
      completeIndexSync({
        ...completion,
        status: 'FAILED',
        errorMessage: 'offline',
      }),
    ).resolves.toMatchObject({ outcome: 'failure_recorded' });

    expect(workspace.searchWithdrawalId).toBe(completion.operationToken);
    expect(mocks.prisma.transcriptWorkspace.updateMany).not.toHaveBeenCalled();
  });

  it('does not finish while search still reports a corrected artifact', async () => {
    await expect(
      completeIndexSync({
        ...completion,
        transcriptPath: `/corrections/corrections_${CATALOG_ID}/workspace/publications/old/transcript.json`,
      }),
    ).resolves.toMatchObject({ outcome: 'source_mismatch' });

    expect(workspace.searchWithdrawalId).toBe(completion.operationToken);
  });

  it('ignores a callback for a different generation', async () => {
    await expect(
      completeIndexSync({ ...completion, operationToken: 'stale-operation' }),
    ).resolves.toMatchObject({ outcome: 'ignored' });

    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(workspace.searchWithdrawalId).toBe(completion.operationToken);
  });

  it('rechecks the generation if a report becomes stale while waiting for the lock', async () => {
    mocks.prisma.transcriptWorkspace.updateMany.mockResolvedValueOnce({
      count: 0,
    });

    await expect(completeIndexSync(completion)).resolves.toMatchObject({
      outcome: 'ignored',
    });

    expect(workspace.searchWithdrawalId).toBe(completion.operationToken);
  });
});

it('requires legacy publication disagreement to be unpublished before publishing', async () => {
  workspace.readerPublicationId = null;

  await expect(publishTranscript(input)).rejects.toMatchObject({
    code: 'PUBLICATION_REQUIRES_UNPUBLISH',
    statusCode: 409,
  });
  expect(mocks.evaluateWorkspace).not.toHaveBeenCalled();
  expect(mocks.prisma.transcriptPublication.create).not.toHaveBeenCalled();
  expect(workspace.searchPublicationId).toBe('publication-1');
});
