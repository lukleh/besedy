import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/admin/users/stats/route";

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
  },
}));

vi.mock("@/lib/admission/admin-read-models", () => ({
  countPendingPortalAdmissions: vi.fn(),
}));

describe("admin users stats route", () => {
  let getAdminCapability: ReturnType<typeof vi.fn>;
  let requireAuth: ReturnType<typeof vi.fn>;
  let countPendingPortalAdmissions: ReturnType<typeof vi.fn>;
  let prisma: {
    user: { count: ReturnType<typeof vi.fn> };
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
    prisma.user.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2);
    countPendingPortalAdmissions.mockResolvedValue(5);
  });

  it("uses canonical portal admission counts for pending users", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      total: 10,
      active: 7,
      pending: 5,
      blocked: 2,
    });
    expect(countPendingPortalAdmissions).toHaveBeenCalledOnce();
  });

  it("rejects non-admin access", async () => {
    getAdminCapability.mockResolvedValue({ canAccessAdmin: false });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(countPendingPortalAdmissions).not.toHaveBeenCalled();
  });
});
