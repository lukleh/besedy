import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  DELETE,
  GET,
  PUT,
} from "@/app/api/catalogs/[id]/route";

vi.mock("@/lib/auth/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/permissions")>()),
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/catalog-management-route-access", () => ({
  requireCatalogManagementAccess: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
  logCatalogLifecycleEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    workflowGroup: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return {
    default: {
      workflowGroup: {
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      userPreferences: {
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
  };
});

const catalogId = "20260201_120000";
const browserMutationHeaders = {
  "Content-Type": "application/json",
  Origin: "http://localhost",
};

function makeAccess(
  userId = "admin-1",
  systemRole: "ADMIN" | "SUPERADMIN" | "USER" = "ADMIN"
) {
  // System admins reach the catalog without a grant; anyone else here holds a
  // stored catalog_admin grant on it.
  const catalogGrant =
    systemRole === "USER" ? { role: "catalog_admin", extras: [] } : null;
  return {
    ok: true as const,
    userId,
    catalogId,
    actor: {
      userId,
      systemRole,
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant,
      isCatalogAdmin: true,
    },
    policyContext: {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant,
      isCatalogAdmin: true,
    },
  };
}

const storedCatalog = {
  id: catalogId,
  label: "Old Catalog",
  archivedCatalogPath: "/data/a/archived.csv",
  metadataCatalogPath: "/data/a/metadata.csv",
  duplicatesCatalogPath: null,
  transcriptsPath: "/data/a/transcripts",
  isDefault: false,
  isActive: true,
};

/** What the settings form sends: the whole draft, unchanged fields included. */
const formPayload = {
  label: storedCatalog.label,
  archivedCatalogPath: storedCatalog.archivedCatalogPath,
  metadataCatalogPath: storedCatalog.metadataCatalogPath,
  duplicatesCatalogPath: storedCatalog.duplicatesCatalogPath,
  transcriptsPath: storedCatalog.transcriptsPath,
  isDefault: storedCatalog.isDefault,
  isActive: storedCatalog.isActive,
};

function putCatalog(body: unknown) {
  return PUT(
    new NextRequest(`http://localhost/api/catalogs/${catalogId}`, {
      method: "PUT",
      headers: browserMutationHeaders,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: catalogId }) }
  );
}

describe("catalog config route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let requireCatalogManagementAccess: ReturnType<typeof vi.fn>;
  let logAccessDenied: ReturnType<typeof vi.fn>;
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
    $transaction: ReturnType<typeof vi.fn>;
    __tx: {
      workflowGroup: {
        update: ReturnType<typeof vi.fn>;
        updateMany: ReturnType<typeof vi.fn>;
      };
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
    const logger = await import("@/lib/audit/logger");
    logAccessDenied = logger.logAccessDenied as ReturnType<typeof vi.fn>;
    logCatalogLifecycleEvent = logger.logCatalogLifecycleEvent as ReturnType<
      typeof vi.fn
    >;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    prisma.__tx.workflowGroup.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...storedCatalog,
        ...data,
      })
    );
    prisma.__tx.workflowGroup.updateMany.mockResolvedValue({ count: 1 });
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
    });

    const response = await GET(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}`),
      { params: Promise.resolve({ id: catalogId }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: catalogId,
      label: "Test Catalog",
    });
  });

  it("logs catalog updates with the actor resolved through catalog policy access", async () => {
    requireAuth.mockResolvedValue("admin-2");
    requireCatalogManagementAccess.mockResolvedValue(makeAccess("admin-2"));
    prisma.workflowGroup.findUnique.mockResolvedValue(storedCatalog);

    const response = await putCatalog({ label: "New Catalog" });

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

  describe("catalog administrator without system authority", () => {
    beforeEach(() => {
      requireAuth.mockResolvedValue("catalog-admin-1");
      requireCatalogManagementAccess.mockResolvedValue(
        makeAccess("catalog-admin-1", "USER")
      );
      prisma.workflowGroup.findUnique.mockResolvedValue(storedCatalog);
    });

    it("may change the label", async () => {
      const response = await putCatalog({ label: "Renamed" });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ label: "Renamed" });
      expect(prisma.__tx.workflowGroup.update).toHaveBeenCalledWith({
        where: { id: catalogId },
        data: { label: "Renamed" },
      });
      expect(logAccessDenied).not.toHaveBeenCalled();
    });

    it("may save the whole form when only the label changed", async () => {
      const response = await putCatalog({ ...formPayload, label: null });

      expect(response.status).toBe(200);
      expect(logCatalogLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { changes: { label: { from: "Old Catalog", to: null } } },
        })
      );
      expect(prisma.__tx.workflowGroup.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      ["archivedCatalogPath", "/data/b/archived.csv"],
      ["metadataCatalogPath", "/data/b/metadata.csv"],
      ["duplicatesCatalogPath", "/data/b/duplicates.csv"],
      ["transcriptsPath", "/data/b/transcripts"],
      ["transcriptsPath", null],
      ["isDefault", true],
      ["isActive", false],
    ])("is refused a change to %s (%j)", async (field, value) => {
      const response = await putCatalog({
        ...formPayload,
        label: "Renamed",
        [field]: value,
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "FORBIDDEN",
        error:
          "System admin access required to change catalog paths, default or active flags",
      });
      expect(logAccessDenied).toHaveBeenCalledWith(
        "catalog-admin-1",
        "catalog_settings",
        catalogId,
        expect.objectContaining({ catalogId, fields: [field] })
      );
      // Nothing is written, not even the permitted label change.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.workflowGroup.update).not.toHaveBeenCalled();
      expect(logCatalogLifecycleEvent).not.toHaveBeenCalled();
    });

    it("does not unset other defaults when saving the default catalog unchanged", async () => {
      prisma.workflowGroup.findUnique.mockResolvedValue({
        ...storedCatalog,
        isDefault: true,
      });

      const response = await putCatalog({
        ...formPayload,
        isDefault: true,
        label: "Renamed",
      });

      expect(response.status).toBe(200);
      expect(prisma.__tx.workflowGroup.updateMany).not.toHaveBeenCalled();
      // Unchanged paths in the body are not written back.
      expect(prisma.__tx.workflowGroup.update).toHaveBeenCalledWith({
        where: { id: catalogId },
        data: { label: "Renamed" },
      });
    });

    it("cannot reactivate a catalog a system admin deactivated", async () => {
      prisma.workflowGroup.findUnique.mockResolvedValue({
        ...storedCatalog,
        isActive: false,
      });

      const response = await putCatalog({ isActive: true });

      expect(response.status).toBe(403);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  it("lets a system admin change paths and flags", async () => {
    requireAuth.mockResolvedValue("admin-4");
    requireCatalogManagementAccess.mockResolvedValue(makeAccess("admin-4", "SUPERADMIN"));
    prisma.workflowGroup.findUnique.mockResolvedValue(storedCatalog);

    const response = await putCatalog({
      ...formPayload,
      archivedCatalogPath: "/data/new/archived.csv",
      duplicatesCatalogPath: "/data/new/duplicates.csv",
      transcriptsPath: null,
      isActive: false,
    });

    expect(response.status).toBe(200);
    expect(logAccessDenied).not.toHaveBeenCalled();
    expect(logCatalogLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-4",
        details: {
          changes: {
            archivedCatalogPath: {
              from: "/data/a/archived.csv",
              to: "/data/new/archived.csv",
            },
            duplicatesCatalogPath: { from: null, to: "/data/new/duplicates.csv" },
            transcriptsPath: { from: "/data/a/transcripts", to: null },
            isActive: { from: true, to: false },
          },
        },
      })
    );
  });

  it("unsets other default catalogs in the same transaction as the update", async () => {
    requireAuth.mockResolvedValue("admin-5");
    requireCatalogManagementAccess.mockResolvedValue(makeAccess("admin-5"));
    prisma.workflowGroup.findUnique.mockResolvedValue(storedCatalog);

    const response = await putCatalog({ isDefault: true });

    expect(response.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.workflowGroup.updateMany).toHaveBeenCalledWith({
      where: { isDefault: true, id: { not: catalogId } },
      data: { isDefault: false },
    });
    expect(prisma.__tx.workflowGroup.update).toHaveBeenCalledWith({
      where: { id: catalogId },
      data: { isDefault: true },
    });
    expect(
      prisma.__tx.workflowGroup.updateMany.mock.invocationCallOrder[0]
    ).toBeLessThan(prisma.__tx.workflowGroup.update.mock.invocationCallOrder[0]);
    // Neither write goes around the transaction client.
    expect(prisma.workflowGroup.updateMany).not.toHaveBeenCalled();
    expect(prisma.workflowGroup.update).not.toHaveBeenCalled();
  });

  it("fails the request when the update inside the default transaction fails", async () => {
    requireAuth.mockResolvedValue("admin-6");
    requireCatalogManagementAccess.mockResolvedValue(makeAccess("admin-6"));
    prisma.workflowGroup.findUnique.mockResolvedValue(storedCatalog);
    prisma.__tx.workflowGroup.update.mockRejectedValue(new Error("write failed"));

    const response = await putCatalog({ isDefault: true });

    expect(response.status).toBe(500);
    expect(prisma.__tx.workflowGroup.updateMany).toHaveBeenCalledTimes(1);
    expect(logCatalogLifecycleEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown field", { label: "x", description: "not a catalog field" }],
    ["a wrongly typed flag", { isDefault: "yes" }],
    ["an empty required path", { archivedCatalogPath: "" }],
    ["a null required path", { metadataCatalogPath: null }],
    ["an overlong label", { label: "x".repeat(101) }],
    ["a non-object body", ["label"]],
    ["invalid JSON", "{label:"],
  ])("rejects %s", async (_name, body) => {
    requireAuth.mockResolvedValue("admin-7");
    requireCatalogManagementAccess.mockResolvedValue(makeAccess("admin-7"));

    const response = await putCatalog(body);

    expect(response.status).toBe(400);
    expect(prisma.workflowGroup.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
