import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DELETE as deleteAdminUser } from "@/app/api/admin/users/[id]/route";

vi.mock("@/lib/auth/permissions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/permissions")>(
    "@/lib/auth/permissions"
  );
  return {
    ...actual,
    requireAuth: vi.fn(),
    isSuperadmin: vi.fn(),
  };
});

vi.mock("@/lib/access/capabilities", () => ({
  getAdminCapability: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    $transaction: vi.fn(),
    session: {
      deleteMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    catalogAccess: {
      updateMany: vi.fn(),
    },
    portalAdmission: {
      updateMany: vi.fn(),
    },
    pendingCatalogGrant: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit/logger", () => ({
  logUserEvent: vi.fn(),
  logAudit: vi.fn(),
  logUserLifecycleEvent: vi.fn(),
}));

describe("admin user delete route", () => {
  const USER_ID = "user12345678901234567";
  let requireAuth: ReturnType<typeof vi.fn>;
  let getAdminCapability: ReturnType<typeof vi.fn>;
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    session: { deleteMany: ReturnType<typeof vi.fn> };
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    catalogAccess: { updateMany: ReturnType<typeof vi.fn> };
    portalAdmission: { updateMany: ReturnType<typeof vi.fn> };
    pendingCatalogGrant: { updateMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    const accessModule = await import("@/lib/access/capabilities");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    getAdminCapability = accessModule.getAdminCapability as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    prisma.$transaction.mockResolvedValue(undefined);
    getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
  });

  it("clears admission and grant actor references before deleting the user", async () => {
    requireAuth.mockResolvedValue("admin-1");
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      isSuperadmin: false,
      email: "target@example.com",
    });

    const response = await deleteAdminUser(
      new NextRequest(`http://localhost/api/admin/users/${USER_ID}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: USER_ID }) }
    );

    expect(response.status).toBe(200);
    expect(prisma.portalAdmission.updateMany).toHaveBeenCalledWith({
      where: { admittedById: USER_ID },
      data: { admittedById: null },
    });
    expect(prisma.portalAdmission.updateMany).toHaveBeenCalledWith({
      where: { claimedById: USER_ID },
      data: { claimedById: null },
    });
    expect(prisma.pendingCatalogGrant.updateMany).toHaveBeenCalledWith({
      where: { grantedById: USER_ID },
      data: { grantedById: null },
    });
    expect(prisma.pendingCatalogGrant.updateMany).toHaveBeenCalledWith({
      where: { consumedById: USER_ID },
      data: { consumedById: null },
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });
});
