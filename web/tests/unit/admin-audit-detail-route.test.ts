import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAuditDetail } from "@/app/api/admin/audit/[id]/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getAdminCapability: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    auditLog: {
      findFirst: vi.fn(),
    },
    audioMetadata: { findFirst: vi.fn() },
    workflowGroup: {
      findUnique: vi.fn(),
    },
    portalAdmission: {
      findUnique: vi.fn(),
    },
    pendingCatalogGrant: {
      findUnique: vi.fn(),
    },
  },
}));

describe("admin audit detail route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getAdminCapability: ReturnType<typeof vi.fn>;
  let prisma: {
    auditLog: {
      findFirst: ReturnType<typeof vi.fn>;
    };
    audioMetadata: { findFirst: ReturnType<typeof vi.fn> };
    workflowGroup: {
      findUnique: ReturnType<typeof vi.fn>;
    };
    portalAdmission: {
      findUnique: ReturnType<typeof vi.fn>;
    };
    pendingCatalogGrant: {
      findUnique: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissions = await import("@/lib/auth/permissions");
    const accessModule = await import("@/lib/access/capabilities");
    requireAuth = permissions.requireAuth as ReturnType<typeof vi.fn>;
    getAdminCapability = accessModule.getAdminCapability as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireAuth.mockResolvedValue("admin-1");
    getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
  });

  it("returns 404 for a missing audit record", async () => {
    prisma.auditLog.findFirst.mockResolvedValue(null);

    const response = await getAuditDetail(
      new NextRequest("http://localhost/api/admin/audit/log-missing-1?expand=true"),
      { params: Promise.resolve({ id: "log-missing-1" }) }
    );

    expect(response.status).toBe(404);
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "log-missing-1",
        },
      })
    );
  });

  it("expands portal admission audit resources", async () => {
    prisma.auditLog.findFirst.mockResolvedValue({
      id: "log-1",
      userId: "admin-1",
      action: "PORTAL_ADMISSION_RESET",
      resource: "portal_admission",
      resourceId: "pending@example.com",
      domain: 'admission',
      subjectType: 'portal_admission',
      outcome: 'changed',
      payloadVersion: 1,
      details: {
        audit: {
          payloadVersion: 1,
          domain: 'admission',
          subjectType: 'portal_admission',
          outcome: 'changed',
          summary: 'Invitation changed',
          actorSnapshot: { type: 'user', userId: 'admin-1' },
          subjectSnapshot: { type: 'portal_admission' }
        }
      },
      ipAddress: null,
      userAgent: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      user: null,
    });
    prisma.portalAdmission.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "portal-1",
        email: "pending@example.com",
        source: "STANDALONE",
        status: "PENDING",
        revocationReason: null,
        admittedAt: "2026-03-10T10:00:00.000Z",
        claimedAt: null,
        revokedAt: null,
        notes: "reset by admin",
        admittedBy: null,
        claimedBy: null,
        revokedBy: null,
      });

    const response = await getAuditDetail(
      new NextRequest("http://localhost/api/admin/audit/log-1?expand=true"),
      { params: Promise.resolve({ id: "log-1" }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "log-1",
      relatedEntity: {
        type: "portal_admission",
        found: true,
        data: {
          id: "portal-1",
          email: "pending@example.com",
          source: "STANDALONE",
          status: "PENDING",
        },
      },
    });
  });

  it("expands pending catalog grant audit resources", async () => {
    prisma.auditLog.findFirst.mockResolvedValue({
      id: "log-2",
      userId: "admin-1",
      action: "PENDING_CATALOG_GRANT_UPDATED",
      resource: "pending_catalog_grant",
      resourceId: "pending@example.com:20260101_000000",
      domain: 'admission',
      subjectType: 'pending_catalog_grant',
      outcome: 'changed',
      payloadVersion: 1,
      details: {
        audit: {
          payloadVersion: 1,
          domain: 'admission',
          subjectType: 'pending_catalog_grant',
          outcome: 'changed',
          summary: 'Invitation changed',
          actorSnapshot: { type: 'user', userId: 'admin-1' },
          subjectSnapshot: { type: 'portal_admission' }
        }
      },
      ipAddress: null,
      userAgent: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      user: null,
    });
    prisma.pendingCatalogGrant.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "grant-1",
        email: "pending@example.com",
        catalogId: "20260101_000000",
        role: "curator",
        status: "PENDING",
        grantedAt: "2026-03-10T10:00:00.000Z",
        consumedAt: null,
        revokedAt: null,
        notes: "catalog invite",
        catalog: {
          id: "20260101_000000",
          label: "Catalog One",
        },
        grantedBy: {
          id: "owner-1",
          name: "Owner User",
          email: "owner@example.com",
        },
        consumedBy: null,
        revokedBy: null,
      });

    const response = await getAuditDetail(
      new NextRequest("http://localhost/api/admin/audit/log-2?expand=true"),
      { params: Promise.resolve({ id: "log-2" }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "log-2",
      relatedEntity: {
        type: "pending_catalog_grant",
        found: true,
        data: {
          id: "grant-1",
          email: "pending@example.com",
          catalogId: "20260101_000000",
          role: "curator",
          status: "PENDING",
        },
      },
    });
  });

  it("keeps foreign historical provenance without resolving the recording in the bound archive", async () => {
    vi.stubEnv("BESEDY_ARCHIVE_ID", "20251225_120000");
    prisma.workflowGroup.findUnique.mockResolvedValue({ id: "20251225_120000", label: "Archive", isActive: true });
    prisma.auditLog.findFirst.mockResolvedValue({
      id: "historical-audio", userId: "admin-1", action: "AUDIO_STREAMED",
      resource: "audio", resourceId: "a".repeat(64), catalogId: "20260101_120000",
      domain: 'data_access',
      subjectType: 'audio',
      outcome: 'success',
      payloadVersion: 1,
      details: {
        audit: {
          payloadVersion: 1,
          domain: 'data_access',
          subjectType: 'audio',
          outcome: 'success',
          summary: 'Audio streamed',
          actorSnapshot: { type: 'user', userId: 'admin-1' },
          subjectSnapshot: { type: 'audio' }
        }
      }, ipAddress: null, userAgent: null,
      createdAt: "2026-03-10T12:00:00.000Z", user: null,
    });
    const response = await getAuditDetail(new NextRequest("http://localhost/api/admin/audit/historical-audio?expand=true"), {
      params: Promise.resolve({ id: "historical-audio" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      target: { catalogId: "20260101_120000" },
      relatedEntity: { type: "audio", found: false, data: null, error: "Historical recording belongs to another source"
      }
    });
    expect(prisma.audioMetadata.findFirst).not.toHaveBeenCalled()
  });

  it('does not expand recording events without recorded source provenance', async () => {
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'unscoped',
      userId: 'admin-1',
      action: 'AUDIO_STREAMED',
      resource: 'audio',
      resourceId: 'a'.repeat(64),
      catalogId: null,
      domain: 'data_access',
      subjectType: 'audio',
      outcome: 'success',
      payloadVersion: 1,
      details: {
        audit: {
          payloadVersion: 1,
          domain: 'data_access',
          subjectType: 'audio',
          outcome: 'success',
          summary: 'Audio streamed',
          actorSnapshot: { type: 'user', userId: 'admin-1' },
          subjectSnapshot: { type: 'audio' }
        }
      },
      ipAddress: null,
      userAgent: null,
      createdAt: new Date(),
      user: null
    });
    const response = await getAuditDetail(
      new NextRequest('http://localhost/api/admin/audit/unscoped?expand=true'),
      { params: Promise.resolve({ id: 'unscoped' }) }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      relatedEntity: {
        found: false,
        error: 'Recording audit has no source provenance'
      },
    });
    expect(prisma.audioMetadata.findFirst).not.toHaveBeenCalled();
  });

});
