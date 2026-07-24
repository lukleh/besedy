import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getUserCatalogAccessRoute } from "@/app/api/admin/users/[id]/catalog-access/route";

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
      findUnique: vi.fn(),
    },
    catalogAccess: {
      findMany: vi.fn(),
    },
  },
}));

describe("admin user catalog access route", () => {
  const USER_ID = "user12345678901234567";
  let getAdminCapability: ReturnType<typeof vi.fn>;
  let requireAuth: ReturnType<typeof vi.fn>;
  let prisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    catalogAccess: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    const accessModule = await import("@/lib/access/capabilities");
    getAdminCapability = accessModule.getAdminCapability as ReturnType<typeof vi.fn>;
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
  });

  it("loads only active catalog access for the admin UI", async () => {
    requireAuth.mockResolvedValue("admin-1");
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID });
    prisma.catalogAccess.findMany.mockResolvedValue([
      {
        catalogId: "cat-1",
        accessLevel: "EDITOR",
        catalog: { id: "cat-1", label: "Catalog A" },
      },
    ]);

    const request = new NextRequest(
      `http://localhost/api/admin/users/${USER_ID}/catalog-access`
    );
    const response = await getUserCatalogAccessRoute(request, {
      params: Promise.resolve({ id: USER_ID }),
    });

    expect(response.status).toBe(200);
    expect(prisma.catalogAccess.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, status: "ACTIVE" },
      })
    );
    const body = await response.json();
    expect(body).toEqual([
      {
        catalogId: "cat-1",
        catalogLabel: "Catalog A",
        accessLevel: "EDITOR",
      },
    ]);
  });
});
