import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveCatalogRecordingRouteAccess,
  requireCatalogAccess,
  requireCatalogRecordingAccess,
  requireCatalogRecordingDownload,
  requireCatalogRecordingEditAccess,
  type CatalogRecordingRouteAccessContext,
} from "@/lib/access/catalog-recording-route-access";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getRecordingCapability: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
}));

describe("catalog recording route access", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;
  let logAccessDenied: ReturnType<typeof vi.fn>;

  const context: CatalogRecordingRouteAccessContext = {
    ok: true,
    userId: "user-1",
    catalogId: "catalog-1",
    hash: "a".repeat(64),
    capability: {
      canAccessRecording: true,
      canDownloadRecording: true,
      canEditRecording: true,
      hasAccess: true,
    } as CatalogRecordingRouteAccessContext["capability"],
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    requireAuth = (await import("@/lib/auth/permissions")).requireAuth as ReturnType<
      typeof vi.fn
    >;
    getRecordingCapability = (
      await import("@/lib/access/capabilities")
    ).getRecordingCapability as ReturnType<typeof vi.fn>;
    logAccessDenied = (await import("@/lib/audit/logger"))
      .logAccessDenied as ReturnType<typeof vi.fn>;
  });

  it("returns 404 when the catalog is missing", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: false,
    });

    const result = await resolveCatalogRecordingRouteAccess(
      "catalog-1",
      "a".repeat(64)
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected access failure");
    }
    expect(result.response.status).toBe(404);
    await expect(result.response.json()).resolves.toEqual({
      error: "Catalog not found",
    });
  });

  it("returns shared route context on success", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canAccessRecording: true,
    });

    const result = await resolveCatalogRecordingRouteAccess(
      "catalog-1",
      "a".repeat(64)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected access success");
    }
    expect(result.userId).toBe("user-1");
    expect(result.catalogId).toBe("catalog-1");
    expect(result.hash).toBe("a".repeat(64));
  });

  it("denies missing catalog access with audit logging", async () => {
    const response = await requireCatalogAccess(
      {
        ...context,
        capability: { ...context.capability, hasAccess: false },
      },
      {
        auditResource: "catalog_entry",
        deniedMessage: "Access denied to this catalog",
      }
    );

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Access denied to this catalog",
    });
    expect(logAccessDenied).toHaveBeenCalledWith(
      "user-1",
      "catalog_entry",
      "a".repeat(64),
      {
        groupId: "catalog-1",
        reason: "No access grant",
      }
    );
  });

  it("supports catalog-scoped audit ids for catalog access denials", async () => {
    await requireCatalogAccess(
      {
        ...context,
        capability: { ...context.capability, hasAccess: false },
      },
      {
        auditResource: "catalog_entry",
        auditResourceId: "catalog-1",
        deniedMessage: "Access denied to this catalog",
      }
    );

    expect(logAccessDenied).toHaveBeenCalledWith(
      "user-1",
      "catalog_entry",
      "catalog-1",
      {
        groupId: "catalog-1",
        reason: "No access grant",
      }
    );
  });

  it("denies hidden recordings with route-specific messages", async () => {
    const response = await requireCatalogRecordingAccess(
      {
        ...context,
        capability: { ...context.capability, canAccessRecording: false },
      },
      {
        auditResource: "audio",
        deniedMessage: "Access denied to this recording",
      }
    );

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Access denied to this recording",
    });
  });

  it("denies downloads with the standard download reason", async () => {
    const response = await requireCatalogRecordingDownload(
      {
        ...context,
        capability: { ...context.capability, canDownloadRecording: false },
      },
      {
        auditResource: "audio",
        deniedMessage: "Download not permitted for this recording",
      }
    );

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Download not permitted for this recording",
    });
    expect(logAccessDenied).toHaveBeenCalledWith(
      "user-1",
      "audio",
      "a".repeat(64),
      {
        groupId: "catalog-1",
        reason: "Download not permitted",
      }
    );
  });

  it("distinguishes no-access from edit-denied reasons", async () => {
    const noGrantResponse = await requireCatalogRecordingEditAccess(
      {
        ...context,
        capability: {
          ...context.capability,
          hasAccess: false,
          canEditRecording: false,
        },
      },
      {
        auditResource: "catalog",
        deniedMessage: "Edit permission required for recording details",
      }
    );

    expect(noGrantResponse?.status).toBe(403);
    expect(logAccessDenied).toHaveBeenLastCalledWith(
      "user-1",
      "catalog",
      "a".repeat(64),
      {
        groupId: "catalog-1",
        reason: "No access grant",
      }
    );

    const noEditResponse = await requireCatalogRecordingEditAccess(
      {
        ...context,
        capability: {
          ...context.capability,
          hasAccess: true,
          canEditRecording: false,
        },
      },
      {
        auditResource: "catalog",
        deniedMessage: "Edit permission required for recording details",
      }
    );

    expect(noEditResponse?.status).toBe(403);
    expect(logAccessDenied).toHaveBeenLastCalledWith(
      "user-1",
      "catalog",
      "a".repeat(64),
      {
        groupId: "catalog-1",
        reason: "Edit permission required",
      }
    );
  });
});
