import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/audit/route";

vi.mock("@/lib/auth/permissions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/permissions")>(
    "@/lib/auth/permissions"
  );
  return {
    ...actual,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/access/capabilities", () => ({
  getAdminCapability: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    auditLog: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

describe("admin audit route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getAdminCapability: ReturnType<typeof vi.fn>;
  let prisma: {
    auditLog: {
      count: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    const accessModule = await import("@/lib/access/capabilities");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    getAdminCapability = accessModule.getAdminCapability as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireAuth.mockResolvedValue("admin-1");
    getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
    prisma.auditLog.count.mockResolvedValue(1);
  });

  function mockCanonicalFindManySequence() {
    prisma.auditLog.findMany
      .mockResolvedValueOnce([{ resource: "auth" }, { resource: "catalog_access" }])
      .mockResolvedValueOnce([{ domain: "auth" }, { domain: "catalog_access" }])
      .mockResolvedValueOnce([{ subjectType: "user" }, { subjectType: "catalog_access" }])
      .mockResolvedValueOnce([{ outcome: "success" }, { outcome: "changed" }])
      .mockResolvedValueOnce([
        {
          id: "log-1",
          userId: "admin-1",
          action: "LOGIN",
          domain: "auth",
          subjectType: "user",
          subjectId: "admin-1",
          catalogId: null,
          outcome: "success",
          payloadVersion: 1,
          resource: "auth",
          resourceId: "admin-1",
          details: null,
          ipAddress: null,
          userAgent: null,
          createdAt: new Date("2026-03-15T03:00:00.000Z"),
          user: {
            id: "admin-1",
            name: "Admin",
            email: "admin@example.com",
            image: null,
          },
        },
      ]);
  }

  it("defaults to canonical rows and exposes canonical filter options", async () => {
    mockCanonicalFindManySequence();

    const response = await GET(
      new NextRequest("http://localhost/api/admin/audit?page=1&limit=10")
    );

    expect(response.status).toBe(200);
    expect(prisma.auditLog.count).toHaveBeenCalledWith({
      where: {
        AND: [
          { resource: { not: "invitation" } },
          { domain: { not: null } },
        ],
      },
    });
    expect(prisma.auditLog.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          AND: [
            { resource: { not: "invitation" } },
            { domain: { not: null } },
          ],
        },
      })
    );

    expect(await response.json()).toMatchObject({
      filters: {
        domains: ["auth", "catalog_access"],
        subjectTypes: ["user", "catalog_access"],
        outcomes: ["success", "changed"],
      },
      logs: [
        {
          id: "log-1",
          domain: "auth",
          outcome: "success",
          isCanonical: true,
        },
      ],
    });
  });
});
