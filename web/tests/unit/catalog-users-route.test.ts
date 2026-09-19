import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getCatalogUsers } from "@/app/api/catalogs/[id]/users/route";
import { grantFromLevel } from "@/lib/policy/catalog-permissions";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/catalog-management-route-access", () => ({
  resolveCatalogManagementActor: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    workflowGroup: {
      findUnique: vi.fn(),
    },
    catalogAccess: {
      findMany: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

const catalogId = "20251225_120000";

describe("catalog users search route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let resolveCatalogManagementActor: ReturnType<typeof vi.fn>;
  let prisma: {
    workflowGroup: { findUnique: ReturnType<typeof vi.fn> };
    catalogAccess: { findMany: ReturnType<typeof vi.fn> };
    user: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    requireAuth = (await import("@/lib/auth/permissions"))
      .requireAuth as ReturnType<typeof vi.fn>;
    resolveCatalogManagementActor = (
      await import("@/lib/access/catalog-management-route-access")
    ).resolveCatalogManagementActor as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireAuth.mockResolvedValue("user-1");
    resolveCatalogManagementActor.mockResolvedValue({
      ok: true,
      userId: "user-1",
      catalogId,
      actor: { isCatalogAdmin: false },
      policyContext: {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: grantFromLevel("OWNER"),
        isCatalogAdmin: false,
      },
    });
    prisma.workflowGroup.findUnique.mockResolvedValue({ id: catalogId });
  });

  it("returns empty results for short search queries", async () => {
    const response = await getCatalogUsers(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/users?search=a`
      ),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      users: [],
      canInvite: false,
    });
  });

  it("sets canInvite when search is a new email", async () => {
    prisma.catalogAccess.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.findFirst.mockResolvedValue(null);

    const email = "newuser@example.com";
    const response = await getCatalogUsers(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/users?search=${encodeURIComponent(email)}`
      ),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      users: [],
      canInvite: true,
      inviteEmail: email,
    });
  });

  it("includes active catalog grants so the dialog can offer updates", async () => {
    prisma.catalogAccess.findMany
      .mockResolvedValueOnce([
        {
          id: "grant-1",
          accessLevel: "VIEWER",
          role: "reader",
          extraPermissions: [],
          notes: "existing notes",
          user: {
            id: "user-2",
            name: "Viewer User",
            email: "viewer@example.com",
            image: null,
          },
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.findFirst.mockResolvedValue({ id: "user-2" });

    const response = await getCatalogUsers(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/users?search=viewer`
      ),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      users: [
        {
          id: "user-2",
          name: "Viewer User",
          email: "viewer@example.com",
          image: null,
          type: "active",
          currentAccessLevel: "VIEWER",
          currentRole: "reader",
          extraPermissions: [],
          notes: "existing notes",
        },
      ],
      canInvite: false,
      inviteEmail: undefined,
    });
  });

  it("offers only grants the actor may act on", async () => {
    prisma.catalogAccess.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.findFirst.mockResolvedValue(null);

    const response = await getCatalogUsers(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/users?search=owner`
      ),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    expect(prisma.catalogAccess.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          catalogId,
          status: "ACTIVE",
        }),
      })
    );
    expect(prisma.catalogAccess.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          catalogId,
          status: "REVOKED",
        }),
      })
    );
    expect(prisma.catalogAccess.findMany.mock.calls[0][0]).toMatchObject({
      take: 50,
      orderBy: { id: "asc" },
    });
    expect(prisma.catalogAccess.findMany.mock.calls[1][0]).toMatchObject({
      take: 50,
      orderBy: { id: "asc" },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "user-1" } }),
      })
    );
  });

  it("pages past unmanageable grants without loading an unbounded result", async () => {
    const protectedPage = Array.from({ length: 50 }, (_, index) => ({
      id: `protected-${String(index).padStart(2, "0")}`,
      accessLevel: "OWNER",
      role: "catalog_admin",
      extraPermissions: [],
      notes: null,
      user: {
        id: `admin-${index}`,
        name: `Admin ${index}`,
        email: `admin${index}@example.com`,
        image: null,
      },
    }));
    prisma.catalogAccess.findMany.mockImplementation(async (args) => {
      if (args.where.status === "REVOKED") return [];
      if (!args.cursor) return protectedPage;
      return [
        {
          id: "reader-grant",
          accessLevel: "VIEWER",
          role: "reader",
          extraPermissions: [],
          notes: null,
          user: {
            id: "reader-1",
            name: "Reader",
            email: "reader@example.com",
            image: null,
          },
        },
      ];
    });
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.findFirst.mockResolvedValue(null);

    const response = await getCatalogUsers(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/users?search=reader`
      ),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    expect((await response.json()).users).toEqual([
      expect.objectContaining({ id: "reader-1", type: "active" }),
    ]);
    expect(prisma.catalogAccess.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "protected-49" },
        skip: 1,
        take: 50,
      })
    );
  });
});
