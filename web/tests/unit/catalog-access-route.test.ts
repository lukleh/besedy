import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAccess, POST as postAccess } from "@/app/api/catalogs/[id]/access/route";
import {
  DELETE as deleteAccess,
  PATCH as patchAccess,
  PUT as putAccess,
} from "@/app/api/catalogs/[id]/access/[userId]/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/catalog-management-route-access", () => ({
  resolveCatalogManagementActor: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logCatalogAccessEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    $transaction: vi.fn(),
    workflowGroup: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    catalogAccess: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));

const catalogId = "20251225_120000";
const userId = "user12345678901234567890";
const browserMutationHeaders = {
  "Content-Type": "application/json",
  Origin: "http://localhost",
};

function makeManagementAccess({
  resolvedUserId = "owner-1",
  catalogGrant = "OWNER",
  isCatalogAdmin = false,
  canEnterPortal = true,
  catalogExists = true,
}: {
  resolvedUserId?: string;
  catalogGrant?: "LISTENER" | "VIEWER" | "MEMBER" | "EDITOR" | "OWNER" | null;
  isCatalogAdmin?: boolean;
  canEnterPortal?: boolean;
  catalogExists?: boolean;
} = {}) {
  return {
    ok: true as const,
    userId: resolvedUserId,
    catalogId,
    actor: {
      catalogExists,
      isCatalogAdmin,
    },
    policyContext: {
      catalogExists,
      canEnterPortal,
      catalogGrant,
      isCatalogAdmin,
    },
  };
}

describe("catalog access routes", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let resolveCatalogManagementActor: ReturnType<typeof vi.fn>;
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    workflowGroup: { findUnique: ReturnType<typeof vi.fn> };
    user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    catalogAccess: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
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
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
      callback(prisma)
    );
  });

  it("GET /api/catalogs/:id/access returns 403 when user cannot manage access", async () => {
    requireAuth.mockResolvedValue("user-1");
    resolveCatalogManagementActor.mockResolvedValue(
      makeManagementAccess({ resolvedUserId: "user-1", catalogGrant: "VIEWER" })
    );
    prisma.workflowGroup.findUnique.mockResolvedValue({ id: catalogId, label: "Test" });

    const response = await getAccess(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/access`),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/OWNER or Admin/),
    });
  });

  it("POST /api/catalogs/:id/access blocks OWNER grant for non-admin", async () => {
    requireAuth.mockResolvedValue("owner-1");
    resolveCatalogManagementActor.mockResolvedValue(makeManagementAccess());
    prisma.workflowGroup.findUnique.mockResolvedValue({ id: catalogId });
    prisma.user.findUnique.mockResolvedValue({ id: userId });

    const response = await postAccess(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/access`, {
        method: "POST",
        headers: browserMutationHeaders,
        body: JSON.stringify({ userId, accessLevel: "OWNER" }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/Only administrators/),
    });
  });

  it("POST /api/catalogs/:id/access blocks restoring revoked OWNER access for non-admin", async () => {
    requireAuth.mockResolvedValue("owner-1");
    resolveCatalogManagementActor.mockResolvedValue(makeManagementAccess());
    prisma.workflowGroup.findUnique.mockResolvedValue({ id: catalogId });
    prisma.user.findUnique.mockResolvedValue({ id: userId });
    prisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "OWNER",
      status: "REVOKED",
    });

    const response = await postAccess(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/access`, {
        method: "POST",
        headers: browserMutationHeaders,
        body: JSON.stringify({ userId, accessLevel: "EDITOR" }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/restore OWNER access/i),
    });
    expect(prisma.catalogAccess.update).not.toHaveBeenCalled();
  });

  it("PUT /api/catalogs/:id/access/:userId rejects updates for revoked access", async () => {
    requireAuth.mockResolvedValue("admin-1");
    resolveCatalogManagementActor.mockResolvedValue(
      makeManagementAccess({ resolvedUserId: "admin-1", isCatalogAdmin: true })
    );
    prisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "VIEWER",
      status: "REVOKED",
    });

    const response = await putAccess(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/access/${userId}`, {
        method: "PUT",
        headers: browserMutationHeaders,
        body: JSON.stringify({ accessLevel: "VIEWER" }),
      }),
      { params: Promise.resolve({ id: catalogId, userId }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/Cannot update revoked access/),
    });
  });

  it("PUT /api/catalogs/:id/access/:userId returns 404 when catalog is missing", async () => {
    requireAuth.mockResolvedValue("admin-1");
    resolveCatalogManagementActor.mockResolvedValue(
      makeManagementAccess({
        resolvedUserId: "admin-1",
        isCatalogAdmin: true,
        catalogExists: false,
      })
    );

    const response = await putAccess(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/access/${userId}`, {
        method: "PUT",
        headers: browserMutationHeaders,
        body: JSON.stringify({ accessLevel: "VIEWER" }),
      }),
      { params: Promise.resolve({ id: catalogId, userId }) }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Catalog not found",
      code: "NOT_FOUND",
    });
    expect(prisma.catalogAccess.findUnique).not.toHaveBeenCalled();
  });

  it("DELETE /api/catalogs/:id/access/:userId blocks self-revocation", async () => {
    requireAuth.mockResolvedValue(userId);
    resolveCatalogManagementActor.mockResolvedValue(
      makeManagementAccess({ resolvedUserId: userId, isCatalogAdmin: true })
    );
    prisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "VIEWER",
      status: "ACTIVE",
      user: { email: "self@test.com" },
    });

    const response = await deleteAccess(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/access/${userId}`, {
        method: "DELETE",
        headers: { Origin: "http://localhost" },
      }),
      { params: Promise.resolve({ id: catalogId, userId }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/Cannot revoke your own access/),
    });
  });

  it("PATCH /api/catalogs/:id/access/:userId rejects restore when access is already active", async () => {
    requireAuth.mockResolvedValue("admin-1");
    resolveCatalogManagementActor.mockResolvedValue(
      makeManagementAccess({ resolvedUserId: "admin-1", isCatalogAdmin: true })
    );
    prisma.catalogAccess.findUnique.mockResolvedValue({
      accessLevel: "VIEWER",
      status: "ACTIVE",
      user: { email: "viewer@test.com" },
    });

    const response = await patchAccess(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/access/${userId}`, {
        method: "PATCH",
        headers: browserMutationHeaders,
        body: JSON.stringify({ action: "restore" }),
      }),
      { params: Promise.resolve({ id: catalogId, userId }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/already active/i),
    });
  });

  describe("happy path - successful operations", () => {
    it("rejects cross-origin access mutations", async () => {
      const response = await postAccess(
        new NextRequest(`http://localhost/api/catalogs/${catalogId}/access`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://evil.example",
          },
          body: JSON.stringify({ userId, accessLevel: "VIEWER" }),
        }),
        { params: Promise.resolve({ id: catalogId }) }
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid request origin",
        code: "FORBIDDEN",
      });
      expect(requireAuth).not.toHaveBeenCalled();
    });

    it("GET /api/catalogs/:id/access returns access list for authorized user", async () => {
      requireAuth.mockResolvedValue("admin-1");
      resolveCatalogManagementActor.mockResolvedValue(
        makeManagementAccess({ resolvedUserId: "admin-1", isCatalogAdmin: true })
      );
      prisma.workflowGroup.findUnique.mockResolvedValue({ id: catalogId, label: "Test Catalog" });
      prisma.catalogAccess.findMany.mockResolvedValue([
        {
          id: "access-1",
          userId: "user-1",
          catalogId,
          accessLevel: "OWNER",
          status: "ACTIVE",
          user: { id: "user-1", name: "Owner User", email: "owner@test.com" },
          grantedBy: { id: "admin-1", name: "Admin" },
        },
        {
          id: "access-2",
          userId: "user-2",
          catalogId,
          accessLevel: "VIEWER",
          status: "ACTIVE",
          user: { id: "user-2", name: "Viewer User", email: "viewer@test.com" },
          grantedBy: { id: "admin-1", name: "Admin" },
        },
      ]);

      const response = await getAccess(
        new NextRequest(`http://localhost/api/catalogs/${catalogId}/access`),
        { params: Promise.resolve({ id: catalogId }) }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        accessList: [
          expect.objectContaining({ accessLevel: "OWNER" }),
          expect.objectContaining({ accessLevel: "VIEWER" }),
        ],
        canManageAccess: true,
        canManageCatalogConfig: true,
        canManageOwnerAccess: true,
      });
    });

    it("POST /api/catalogs/:id/access creates new access successfully", async () => {
      requireAuth.mockResolvedValue("owner-1");
      resolveCatalogManagementActor.mockResolvedValue(makeManagementAccess());
      prisma.workflowGroup.findUnique.mockResolvedValue({ id: catalogId, label: "Catalog" });
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        name: "New User",
        email: "new@test.com",
      });
      prisma.catalogAccess.findUnique.mockResolvedValue(null);
      prisma.user.update.mockResolvedValue({
        id: userId,
        name: "Updated User",
      });
      prisma.catalogAccess.create.mockResolvedValue({
        id: "new-access",
        userId,
        catalogId,
        accessLevel: "VIEWER",
        status: "ACTIVE",
        grantedById: "owner-1",
        createdAt: new Date(),
        user: { id: userId, name: "New User", email: "new@test.com" },
      });

      const response = await postAccess(
        new NextRequest(`http://localhost/api/catalogs/${catalogId}/access`, {
          method: "POST",
          headers: browserMutationHeaders,
          body: JSON.stringify({
            userId,
            accessLevel: "VIEWER",
            userName: "Updated User",
          }),
        }),
        { params: Promise.resolve({ id: catalogId }) }
      );

      expect(response.status).toBe(201);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { name: "Updated User" },
      });
      await expect(response.json()).resolves.toMatchObject({
        accessLevel: "VIEWER",
        status: "ACTIVE",
      });
    });

    it("POST /api/catalogs/:id/access allows admin to grant OWNER access", async () => {
      requireAuth.mockResolvedValue("admin-1");
      resolveCatalogManagementActor.mockResolvedValue(
        makeManagementAccess({ resolvedUserId: "admin-1", isCatalogAdmin: true })
      );
      prisma.workflowGroup.findUnique.mockResolvedValue({ id: catalogId, label: "Catalog" });
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        name: "New Owner",
        email: "owner@test.com",
      });
      prisma.catalogAccess.findUnique.mockResolvedValue(null);
      prisma.catalogAccess.create.mockResolvedValue({
        id: "new-owner-access",
        userId,
        catalogId,
        accessLevel: "OWNER",
        status: "ACTIVE",
        grantedById: "admin-1",
        createdAt: new Date(),
        user: { id: userId, name: "New Owner", email: "owner@test.com" },
      });

      const response = await postAccess(
        new NextRequest(`http://localhost/api/catalogs/${catalogId}/access`, {
          method: "POST",
          headers: browserMutationHeaders,
          body: JSON.stringify({ userId, accessLevel: "OWNER" }),
        }),
        { params: Promise.resolve({ id: catalogId }) }
      );

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        accessLevel: "OWNER",
      });
    });

    it("PUT /api/catalogs/:id/access/:userId updates access level successfully", async () => {
      requireAuth.mockResolvedValue("owner-1");
      resolveCatalogManagementActor.mockResolvedValue(makeManagementAccess());
      prisma.catalogAccess.findUnique.mockResolvedValue({
        userId,
        catalogId,
        accessLevel: "VIEWER",
        status: "ACTIVE",
        user: { id: userId, email: "user@test.com" },
      });
      prisma.catalogAccess.update.mockResolvedValue({
        userId,
        catalogId,
        accessLevel: "EDITOR",
        status: "ACTIVE",
        user: { id: userId, name: "User", email: "user@test.com" },
      });

      const response = await putAccess(
        new NextRequest(`http://localhost/api/catalogs/${catalogId}/access/${userId}`, {
          method: "PUT",
          headers: browserMutationHeaders,
          body: JSON.stringify({ accessLevel: "EDITOR" }),
        }),
        { params: Promise.resolve({ id: catalogId, userId }) }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        accessLevel: "EDITOR",
      });
    });

    it("PUT /api/catalogs/:id/access/:userId clears notes when an empty string is submitted", async () => {
      requireAuth.mockResolvedValue("owner-1");
      resolveCatalogManagementActor.mockResolvedValue(makeManagementAccess());
      prisma.catalogAccess.findUnique.mockResolvedValue({
        userId,
        catalogId,
        accessLevel: "VIEWER",
        status: "ACTIVE",
        notes: "keep me",
        user: { id: userId, email: "user@test.com" },
      });
      prisma.catalogAccess.update.mockResolvedValue({
        userId,
        catalogId,
        accessLevel: "VIEWER",
        status: "ACTIVE",
        notes: null,
        user: { id: userId, name: "User", email: "user@test.com" },
      });

      const response = await putAccess(
        new NextRequest(`http://localhost/api/catalogs/${catalogId}/access/${userId}`, {
          method: "PUT",
          headers: browserMutationHeaders,
          body: JSON.stringify({ accessLevel: "VIEWER", notes: "" }),
        }),
        { params: Promise.resolve({ id: catalogId, userId }) }
      );

      expect(response.status).toBe(200);
      expect(prisma.catalogAccess.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            notes: null,
          }),
        })
      );
    });

    it("DELETE /api/catalogs/:id/access/:userId revokes access successfully", async () => {
      const targetUserId = "targetuser12345678901234";
      requireAuth.mockResolvedValue("owner12345678901234567");
      resolveCatalogManagementActor.mockResolvedValue(
        makeManagementAccess({ resolvedUserId: "owner12345678901234567" })
      );
      prisma.catalogAccess.findUnique.mockResolvedValue({
        userId: targetUserId,
        catalogId,
        accessLevel: "VIEWER",
        status: "ACTIVE",
        user: { id: targetUserId, email: "user@test.com" },
      });
      prisma.catalogAccess.update.mockResolvedValue({
        userId: targetUserId,
        catalogId,
        accessLevel: "VIEWER",
        status: "REVOKED",
      });

      const response = await deleteAccess(
        new NextRequest(`http://localhost/api/catalogs/${catalogId}/access/${targetUserId}`, {
          method: "DELETE",
          headers: { Origin: "http://localhost" },
        }),
        { params: Promise.resolve({ id: catalogId, userId: targetUserId }) }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
    });

    it("PATCH /api/catalogs/:id/access/:userId restores revoked access", async () => {
      requireAuth.mockResolvedValue("admin12345678901234567");
      resolveCatalogManagementActor.mockResolvedValue(
        makeManagementAccess({
          resolvedUserId: "admin12345678901234567",
          isCatalogAdmin: true,
        })
      );
      prisma.catalogAccess.findUnique.mockResolvedValue({
        userId,
        catalogId,
        accessLevel: "VIEWER",
        status: "REVOKED",
        revokedById: "owner-1",
        revokedAt: new Date(),
        user: { id: userId, email: "restored@test.com" },
      });
      prisma.catalogAccess.update.mockResolvedValue({
        userId,
        catalogId,
        accessLevel: "VIEWER",
        status: "ACTIVE",
        revokedById: null,
        revokedAt: null,
        user: { id: userId, name: "Restored User", email: "restored@test.com" },
      });

      const response = await patchAccess(
        new NextRequest(`http://localhost/api/catalogs/${catalogId}/access/${userId}`, {
          method: "PATCH",
          headers: browserMutationHeaders,
          body: JSON.stringify({ action: "restore" }),
        }),
        { params: Promise.resolve({ id: catalogId, userId }) }
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "ACTIVE",
      });
    });
  });
});
