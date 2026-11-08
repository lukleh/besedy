import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET, PUT } from "@/app/api/catalogs/[id]/route";

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

vi.mock("@/lib/db", () => ({
  default: {
    workflowGroup: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

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
  isActive: true,
};

/** What the settings form sends: the whole draft, unchanged fields included. */
const formPayload = {
  label: storedCatalog.label,
  archivedCatalogPath: storedCatalog.archivedCatalogPath,
  metadataCatalogPath: storedCatalog.metadataCatalogPath,
  duplicatesCatalogPath: storedCatalog.duplicatesCatalogPath,
  transcriptsPath: storedCatalog.transcriptsPath,
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
    prisma.workflowGroup.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...storedCatalog,
        ...data,
      })
    );
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
      expect(prisma.workflowGroup.update).toHaveBeenCalledWith({
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
    });

    it.each([
      ["archivedCatalogPath", "/data/b/archived.csv"],
      ["metadataCatalogPath", "/data/b/metadata.csv"],
      ["duplicatesCatalogPath", "/data/b/duplicates.csv"],
      ["transcriptsPath", "/data/b/transcripts"],
      ["transcriptsPath", null],
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
          "System admin access required to change catalog paths",
      });
      expect(logAccessDenied).toHaveBeenCalledWith(
        "catalog-admin-1",
        "catalog_settings",
        catalogId,
        expect.objectContaining({ catalogId, fields: [field] })
      );
      // Nothing is written, not even the permitted label change.
      expect(prisma.workflowGroup.update).not.toHaveBeenCalled();
      expect(logCatalogLifecycleEvent).not.toHaveBeenCalled();
    });
  });

  it("lets a system admin change source paths", async () => {
    requireAuth.mockResolvedValue("admin-4");
    requireCatalogManagementAccess.mockResolvedValue(makeAccess("admin-4", "SUPERADMIN"));
    prisma.workflowGroup.findUnique.mockResolvedValue(storedCatalog);

    const response = await putCatalog({
      ...formPayload,
      archivedCatalogPath: "/data/new/archived.csv",
      duplicatesCatalogPath: "/data/new/duplicates.csv",
      transcriptsPath: null,
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
          },
        },
      })
    );
  });

  it("does not log a source update whose database write failed", async () => {
    requireAuth.mockResolvedValue("admin-6");
    requireCatalogManagementAccess.mockResolvedValue(makeAccess("admin-6"));
    prisma.workflowGroup.findUnique.mockResolvedValue(storedCatalog);
    prisma.workflowGroup.update.mockRejectedValueOnce(new Error("write failed"));

    const response = await putCatalog({ label: "Renamed" });

    expect(response.status).toBe(500);
    expect(logCatalogLifecycleEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown field", { label: "x", description: "not a catalog field" }],
    ["a retired default selection", { isDefault: true }],
    ["a retired deactivation flag", { isActive: false }],
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
