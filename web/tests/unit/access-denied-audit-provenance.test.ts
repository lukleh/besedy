import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { requireCatalogRecordingAccess } from '@/lib/access/catalog-recording-route-access';
import { resolveTranscriptRouteAccess } from '@/lib/access/transcript-route-access';
import { GET as getAuditDetail } from '@/app/api/admin/audit/[id]/route';
import type { RecordingCapability } from '@/lib/access/capabilities';

const { createAudit, findAudit, findMetadata } = vi.hoisted(() => ({
  createAudit: vi.fn(),
  findAudit: vi.fn(),
  findMetadata: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/access/require-admin', () => ({
  requireAdminCapability: vi.fn(),
}));
vi.mock('@/lib/auth/permissions', () => ({
  requireAuth: async () => 'denied-user',
}));
vi.mock('@/lib/access/capabilities', () => ({
  getRecordingCapability: async () => ({ canAccessRecording: false }),
}));
vi.mock('@/lib/archive', () => ({
  requireArchive: async () => ({ id: '20260101_120000' }),
}));
vi.mock('@/lib/catalog/resolve-group', () => ({
  findActiveCatalog: async () => ({ id: '20260101_120000' }),
}));
vi.mock('@/lib/catalog', () => ({ getFullCatalogEntry: async () => null }));
vi.mock('@/lib/db', () => ({
  default: {
    auditLog: { create: createAudit, findFirst: findAudit },
    audioMetadata: { findFirst: findMetadata },
  },
}));

describe('access-denied audit provenance', () => {
  const catalogId = '20260101_120000';
  const hash = 'a'.repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
    createAudit.mockImplementation(async ({ data }) => {
      const saved = {
        ...data,
        id: 'denied-event',
        createdAt: new Date(),
        user: null,
      };
      findAudit.mockResolvedValue(saved);
      return saved;
    });
    findMetadata.mockResolvedValue({
      workflowGroupId: catalogId,
      workflowGroup: { id: catalogId },
    });
  });

  it.each(['audio', 'metadata', 'transcript'])(
    'expands a newly denied %s request in its recorded catalog',
    async (resource) => {
      const denial =
        resource === 'transcript'
          ? await resolveTranscriptRouteAccess({
              catalogId,
              hash,
              auditResource: resource,
              accessDeniedMessage: 'Denied',
            }).then((result) => (result.ok ? null : result.response))
          : await requireCatalogRecordingAccess(
              {
                ok: true,
                userId: 'denied-user',
                catalogId,
                hash,
                capability: {
                  canAccessRecording: false,
                } as RecordingCapability,
              },
              { auditResource: resource, deniedMessage: 'Denied' },
            );
      expect(denial?.status).toBe(403);
      expect(createAudit).toHaveBeenCalledWith({
        data: expect.objectContaining({
          catalogId,
          details: expect.objectContaining({
            audit: expect.objectContaining({
              catalogId,
              subjectSnapshot: expect.objectContaining({ catalogId }),
            }),
          }),
        }),
      });

      const detail = await getAuditDetail(
        new NextRequest(
          'http://localhost/api/admin/audit/denied-event?expand=true',
        ),
        { params: Promise.resolve({ id: 'denied-event' }) },
      );
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        target: { catalogId },
        relatedEntity: { type: 'audio', found: true, data: { hash } },
      });
      expect(findMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { audioHash: hash, workflowGroupId: catalogId },
        }),
      );
    },
  );
});
