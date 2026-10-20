import { beforeEach, describe, expect, it, vi } from 'vitest';

const completeStartingManifest = vi.fn();
vi.mock('@/lib/correction/storage', () => ({ completeStartingManifest }));
vi.mock('@/lib/log/server', () => ({
  createServerLogger: () => ({ warn: vi.fn() }),
}));

const WORKSPACE = '11111111-2222-3333-4444-555555555555';

function txReturning(rows: unknown[]) {
  return { $queryRaw: vi.fn().mockResolvedValue(rows) } as never;
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
});
