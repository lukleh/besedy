import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAuditDetail } from "@/app/api/admin/audit/[id]/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
  isAdmin: vi.fn(),
  isSuperadmin: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getAdminCapability: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    auditLog: {
      findFirst: vi.fn(),
    },
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
  let isAdmin: ReturnType<typeof vi.fn>;
  let isSuperadmin: ReturnType<typeof vi.fn>;
  let prisma: {
    auditLog: {
      findFirst: ReturnType<typeof vi.fn>;
    };
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
    isAdmin = permissions.isAdmin as ReturnType<typeof vi.fn>;
    isSuperadmin = permissions.isSuperadmin as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireAuth.mockResolvedValue("admin-1");
    getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
    isAdmin.mockResolvedValue(true);
    isSuperadmin.mockResolvedValue(false);
  });

  it("returns no related entity for unsupported legacy invitation audit rows", async () => {
    prisma.auditLog.findFirst.mockResolvedValue(null);

    const response = await getAuditDetail(
      new NextRequest("http://localhost/api/admin/audit/log-inv-1?expand=true"),
      { params: Promise.resolve({ id: "log-inv-1" }) }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "Audit log entry not found",
    });
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "log-inv-1",
          resource: { not: "invitation" },
          domain: { not: null },
        },
      })
    );
  });

  it("does not expose pre-cutover audit rows through the detail route", async () => {
    prisma.auditLog.findFirst.mockResolvedValue(null);

    const response = await getAuditDetail(
      new NextRequest("http://localhost/api/admin/audit/log-old-1?expand=true"),
      { params: Promise.resolve({ id: "log-old-1" }) }
    );

    expect(response.status).toBe(404);
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "log-old-1",
          resource: { not: "invitation" },
          domain: { not: null },
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
      details: null,
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
      details: null,
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
        accessLevel: "EDITOR",
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
          accessLevel: "EDITOR",
          status: "PENDING",
        },
      },
    });
  });
});
