import { beforeEach, describe, expect, it, vi } from 'vitest';

const completeStartingManifest = vi.fn();
vi.mock('@/lib/correction/storage', () => ({ completeStartingManifest }));
vi.mock('@/lib/log/server', () => ({
  createServerLogger: () => ({ warn: vi.fn() }),
}));

const WORKSPACE = '11111111-2222-3333-4444-555555555555';

function txReturning(rows: unknown[]) {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue(rows),
  } as never;
}

function txRefusing(error: unknown) {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockRejectedValue(error),
  } as never;
}

describe('lockWorkspace', () => {
  beforeEach(() => {
    completeStartingManifest.mockReset().mockResolvedValue(undefined);
  });

  it('finishes the manifest of a live contract workspace', async () => {
    const { lockWorkspace } = await import('@/lib/correction/workspace-lock');
    await lockWorkspace(
      txReturning([
        {
          id: WORKSPACE,
          workflow_group_id: '20251222_144441',
          status: 'ACTIVE',
          segmentation_version: 'chunks-v1',
        },
      ]),
      WORKSPACE,
    );
    expect(completeStartingManifest).toHaveBeenCalledWith(
      '20251222_144441',
      WORKSPACE,
    );
  });

  it('leaves archived and pre-contract workspaces alone', async () => {
    const { lockWorkspace } = await import('@/lib/correction/workspace-lock');
    await lockWorkspace(
      txReturning([
        {
          id: WORKSPACE,
          workflow_group_id: 'c',
          status: 'ARCHIVED',
          segmentation_version: 'chunks-v1',
        },
      ]),
      WORKSPACE,
    );
    await lockWorkspace(
      txReturning([
        {
          id: WORKSPACE,
          workflow_group_id: 'c',
          status: 'ACTIVE',
          segmentation_version: null,
        },
      ]),
      WORKSPACE,
    );
    expect(completeStartingManifest).not.toHaveBeenCalled();
  });

  it('does not refuse the write when the manifest cannot be finished', async () => {
    const { lockWorkspace } = await import('@/lib/correction/workspace-lock');
    completeStartingManifest.mockRejectedValue(
      new SyntaxError('Unexpected end of JSON input'),
    );
    await expect(
      lockWorkspace(
        txReturning([
          {
            id: WORKSPACE,
            workflow_group_id: 'c',
            status: 'ACTIVE',
            segmentation_version: 'chunks-v1',
          },
        ]),
        WORKSPACE,
      ),
    ).resolves.toBeUndefined();
  });

  it('reports a missing workspace', async () => {
    const { lockWorkspace } = await import('@/lib/correction/workspace-lock');
    await expect(
      lockWorkspace(txReturning([]), WORKSPACE),
    ).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
  });

  // A writer waits a bounded time for the row and then tells the person the
  // workspace is busy, instead of running into its transaction timeout.
  it('bounds the wait for the row and reports a busy workspace', async () => {
    const { WORKSPACE_LOCK_WAIT_MS, lockWorkspace } = await import(
      '@/lib/correction/workspace-lock'
    );
    const tx = txRefusing(
      Object.assign(new Error('Raw query failed. Code: `55P03`'), {
        code: 'P2010',
        meta: { code: '55P03', message: 'canceling statement due to lock timeout' },
      }),
    );
    await expect(lockWorkspace(tx, WORKSPACE)).rejects.toMatchObject({
      code: 'WORKSPACE_LOCKED',
      statusCode: 409,
    });
    expect((tx as { $executeRawUnsafe: ReturnType<typeof vi.fn> }).$executeRawUnsafe).toHaveBeenCalledWith(
      `SET LOCAL lock_timeout = '${WORKSPACE_LOCK_WAIT_MS}ms'`,
    );
  });

  it('passes other query failures through', async () => {
    const { lockWorkspace } = await import('@/lib/correction/workspace-lock');
    const failure = Object.assign(new Error('Raw query failed. Code: `42P01`'), {
      code: 'P2010',
      meta: { code: '42P01' },
    });
    await expect(lockWorkspace(txRefusing(failure), WORKSPACE)).rejects.toBe(failure);
  });
});
