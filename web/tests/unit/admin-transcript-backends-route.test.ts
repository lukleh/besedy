import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/admin/transcript-backends/route';
import prisma from '@/lib/db';
import { discoverTranscriptBackends } from '@/lib/transcript';

vi.mock('@/lib/access/require-admin', () => ({ requireAdminCapability: vi.fn() }));
vi.mock('@/lib/db', () => ({ default: { workflowGroup: { findMany: vi.fn(), findUnique: vi.fn() } } }));
vi.mock('@/lib/paths', () => ({ resolveTranscriptsPath: (id: string) => `/transcripts/${id}` }));
vi.mock('@/lib/transcript', () => ({
  discoverTranscriptBackends: vi.fn(),
  orderTranscriptBackends: (backends: string[]) => backends,
}));
vi.mock('@/lib/transcript-priority', () => ({
  listTranscriptBackendPriorities: vi.fn(async () => ({ 'stored/model': 1 })),
  updateTranscriptBackendPriorities: vi.fn(),
}));
afterEach(() => vi.unstubAllEnvs());

describe('admin transcript backend discovery', () => {
  it('scans only the bound source and retains undiscovered global model priorities', async () => {
    vi.stubEnv('BESEDY_ARCHIVE_ID', '20251225_120000');
    vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue({ id: '20251225_120000', label: 'Archive', isActive: true } as never);
    vi.mocked(prisma.workflowGroup.findMany).mockResolvedValue([{ id: '20251225_120000' }] as never);
    vi.mocked(discoverTranscriptBackends).mockResolvedValue(['current/model']);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(prisma.workflowGroup.findMany).toHaveBeenCalledWith({ select: { id: true }, where: { id: '20251225_120000', isActive: true } });
    expect(discoverTranscriptBackends).toHaveBeenCalledWith(['/transcripts/20251225_120000']);
    expect(await response.json()).toEqual({ items: [
      { backend: 'current/model', priority: null, discovered: true },
      { backend: 'stored/model', priority: 1, discovered: false },
    ] });
  });
});
