import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  DELETE,
  GET,
  PUT,
} from "@/app/api/catalogs/[id]/route";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/catalog-management-route-access", () => ({
  requireCatalogManagementAccess: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logCatalogLifecycleEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    workflowGroup: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    userPreferences: {
      updateMany: vi.fn(),
    },
  },
}));

const catalogId = "20260201_120000";
const browserMutationHeaders = {
  "Content-Type": "application/json",
  Origin: "http://localhost",
};

function makeAccess(userId = "admin-1") {
  return {
    ok: true as const,
    userId,
    catalogId,
    actor: {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: null,
      isCatalogAdmin: true,
    },
    policyContext: {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: null,
      isCatalogAdmin: true,
    },
  };
}

describe("catalog config route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let requireCatalogManagementAccess: ReturnType<typeof vi.fn>;
  let logCatalogLifecycleEvent: ReturnType<typeof vi.fn>;
  let prisma: {
    workflowGroup: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    userPreferences: {
      updateMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    requireAuth = (await import("@/lib/auth/permissions")).requireAuth as ReturnType<
      typeof vi.fn
    >;
    requireCatalogManagementAccess = (
      await import("@/lib/access/catalog-management-route-access")
    ).requireCatalogManagementAccess as ReturnType<typeof vi.fn>;
    logCatalogLifecycleEvent = (await import("@/lib/audit/logger"))
      .logCatalogLifecycleEvent as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  it("returns the policy denial response for unauthorized settings access", async () => {
    requireAuth.mockResolvedValue("owner-1");
    requireCatalogManagementAccess.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        {
          error: "Admin access required to view catalog settings",
          code: "FORBIDDEN",
        },
        { status: 403 }
      ),
    });

    const response = await GET(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}`),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Admin access required to view catalog settings",
      code: "FORBIDDEN",
    });
    expect(requireCatalogManagementAccess).toHaveBeenCalledWith(
      catalogId,
      expect.objectContaining({
        userId: "owner-1",
        activeCatalogOnly: false,
        deniedMessage: "Admin access required to view catalog settings",
        authorize: expect.any(Function),
      })
    );
  });

  it("returns catalog configuration for authorized admins", async () => {
    requireAuth.mockResolvedValue("admin-1");
    requireCatalogManagementAccess.mockResolvedValue(makeAccess("admin-1"));
    prisma.workflowGroup.findUnique.mockResolvedValue({
      id: catalogId,
      label: "Test Catalog",
      variants: [],
    });

    const response = await GET(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}`),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: catalogId,
      label: "Test Catalog",
      variants: [],
    });
  });

  it("logs catalog updates with the actor resolved through catalog policy access", async () => {
    requireAuth.mockResolvedValue("admin-2");
    requireCatalogManagementAccess.mockResolvedValue(makeAccess("admin-2"));
    prisma.workflowGroup.findUnique.mockResolvedValue({
      id: catalogId,
      label: "Old Catalog",
      archivedCatalogPath: "/old-archived.csv",
      metadataCatalogPath: "/old-metadata.csv",
      duplicatesCatalogPath: null,
      transcriptsPath: null,
      isDefault: false,
      isActive: true,
    });
    prisma.workflowGroup.update.mockResolvedValue({
      id: catalogId,
      label: "New Catalog",
      variants: [],
    });

    const response = await PUT(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}`, {
        method: "PUT",
        headers: browserMutationHeaders,
        body: JSON.stringify({ label: "New Catalog" }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    expect(logCatalogLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-2",
        action: "CATALOG_UPDATED",
        catalogId,
        details: {
          changes: {
            label: {
              from: "Old Catalog",
              to: "New Catalog",
            },
          },
        },
      })
    );
  });

  it("logs catalog deactivation with the actor resolved through catalog policy access", async () => {
    requireAuth.mockResolvedValue("admin-3");
    requireCatalogManagementAccess.mockResolvedValue(makeAccess("admin-3"));
    prisma.workflowGroup.findUnique.mockResolvedValue({
      id: catalogId,
      label: "Catalog",
      isDefault: true,
    });
    prisma.workflowGroup.update.mockResolvedValue({
      id: catalogId,
      isActive: false,
      isDefault: false,
    });
    prisma.userPreferences.updateMany.mockResolvedValue({ count: 1 });

    const response = await DELETE(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}`, {
        method: "DELETE",
        headers: { Origin: "http://localhost" },
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    expect(logCatalogLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-3",
        action: "CATALOG_DEACTIVATED",
        catalogId,
      })
    );
  });

  it("rejects cross-origin catalog config updates", async () => {
    const response = await PUT(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ label: "New Catalog" }),
      }),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request origin",
      code: "FORBIDDEN",
    });
    expect(requireAuth).not.toHaveBeenCalled();
    expect(requireCatalogManagementAccess).not.toHaveBeenCalled();
  });
});
