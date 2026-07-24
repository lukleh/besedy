import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getCatalogUsers } from "@/app/api/catalogs/[id]/users/route";

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
    user: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    requireAuth = (await import("@/lib/auth/permissions")).requireAuth as ReturnType<
      typeof vi.fn
    >;
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
        catalogGrant: "OWNER",
        isCatalogAdmin: false,
      },
    });
    prisma.workflowGroup.findUnique.mockResolvedValue({ id: catalogId });
  });

  it("returns empty results for short search queries", async () => {
    const response = await getCatalogUsers(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/users?search=a`),
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
          accessLevel: "VIEWER",
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
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/users?search=viewer`),
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
          notes: "existing notes",
        },
      ],
      canInvite: false,
      inviteEmail: undefined,
    });
  });

  it("excludes owner-level grants from search results when the actor cannot manage owner access", async () => {
    prisma.catalogAccess.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.findFirst.mockResolvedValue(null);

    const response = await getCatalogUsers(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/users?search=owner`),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    expect(prisma.catalogAccess.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          catalogId,
          status: "ACTIVE",
          accessLevel: { not: "OWNER" },
        }),
      })
    );
    expect(prisma.catalogAccess.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          catalogId,
          status: "REVOKED",
          accessLevel: { not: "OWNER" },
        }),
      })
    );
  });
});
