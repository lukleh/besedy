import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/dashboard/stats/route";

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
    user: {
      count: vi.fn(),
    },
    auditLog: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    clientErrorReport: {
      groupBy: vi.fn(),
    },
  },
}));

vi.mock("@/lib/admission/admin-read-models", () => ({
  countPendingPortalAdmissions: vi.fn(),
}));

describe("admin dashboard stats route", () => {
  let getAdminCapability: ReturnType<typeof vi.fn>;
  let requireAuth: ReturnType<typeof vi.fn>;
  let countPendingPortalAdmissions: ReturnType<typeof vi.fn>;
  let prisma: {
    user: { count: ReturnType<typeof vi.fn> };
    auditLog: {
      count: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    clientErrorReport: {
      groupBy: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    const accessModule = await import("@/lib/access/capabilities");
    const admissionReadsModule = await import("@/lib/admission/admin-read-models");
    getAdminCapability = accessModule.getAdminCapability as ReturnType<typeof vi.fn>;
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    countPendingPortalAdmissions =
      admissionReadsModule.countPendingPortalAdmissions as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireAuth.mockResolvedValue("admin-1");
    getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
    countPendingPortalAdmissions.mockResolvedValue(6);

    prisma.user.count
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(3);
    prisma.auditLog.count
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.clientErrorReport.groupBy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
  });

  it("uses canonical portal admission counts for pending users", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.users.pending).toBe(6);
    expect(countPendingPortalAdmissions).toHaveBeenCalledOnce();
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { resource: { not: "invitation" } },
      })
    );
  });

  it("rejects non-admin access", async () => {
    getAdminCapability.mockResolvedValue({ canAccessAdmin: false });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(countPendingPortalAdmissions).not.toHaveBeenCalled();
  });
});
