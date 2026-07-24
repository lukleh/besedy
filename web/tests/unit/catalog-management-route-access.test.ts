import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  requireCatalogManagementAccess,
  resolveCatalogManagementActor,
} from "@/lib/access/catalog-management-route-access";
import { canAttemptCatalogManagement } from "@/lib/policy/catalog";
import { canPublishRecording } from "@/lib/policy/recording";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/policy/actor", () => ({
  resolveCatalogActorContext: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
}));

describe("catalog management route access", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let resolveCatalogActorContext: ReturnType<typeof vi.fn>;
  let logAccessDenied: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    requireAuth = (await import("@/lib/auth/permissions")).requireAuth as ReturnType<
      typeof vi.fn
    >;
    resolveCatalogActorContext = (
      await import("@/lib/policy/actor")
    ).resolveCatalogActorContext as ReturnType<typeof vi.fn>;
    logAccessDenied = (await import("@/lib/audit/logger"))
      .logAccessDenied as ReturnType<typeof vi.fn>;
  });

  it("returns 404 when the catalog does not exist", async () => {
    requireAuth.mockResolvedValue("user-1");
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: false,
      canEnterPortal: true,
      catalogGrant: null,
      isCatalogAdmin: false,
    });

    const result = await requireCatalogManagementAccess("catalog-1", {
      auditResource: "catalog_publication",
      auditResourceId: "hash-1",
      deniedMessage: "Only owner/admin can update publication state",
      deniedReason: "Only owner/admin can update publication state",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected access failure");
    }
    expect(result.response.status).toBe(404);
    await expect(result.response.json()).resolves.toEqual({
      error: "Catalog not found",
      code: "NOT_FOUND",
    });
  });

  it("returns 403 and logs when management authority is missing", async () => {
    requireAuth.mockResolvedValue("user-1");
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: "VIEWER",
      isCatalogAdmin: false,
    });

    const result = await requireCatalogManagementAccess("catalog-1", {
      auditResource: "event_sources",
      auditResourceId: "12",
      deniedMessage: "Access denied to sources",
      deniedReason: "Not owner/admin",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected access failure");
    }
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({
      error: "Access denied to sources",
      code: "FORBIDDEN",
    });
    expect(logAccessDenied).toHaveBeenCalledWith(
      "user-1",
      "event_sources",
      "12",
      {
        catalogId: "catalog-1",
        reason: "Not owner/admin",
      }
    );
  });

  it("supports route-specific authorization predicates", async () => {
    requireAuth.mockResolvedValue("owner-1");
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: "OWNER",
      isCatalogAdmin: false,
    });

    const result = await requireCatalogManagementAccess("catalog-1", {
      auditResource: "catalog_publication",
      auditResourceId: "hash-1",
      deniedMessage: "Only owner/admin can update publication state",
      deniedReason: "Only owner/admin can update publication state",
      authorize: canPublishRecording,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected access success");
    }
    expect(result.userId).toBe("owner-1");
    expect(result.policyContext.catalogGrant).toBe("OWNER");
  });

  it("preserves admin management authority when inactive-catalog checks are disabled", async () => {
    requireAuth.mockResolvedValue("admin-1");
    resolveCatalogActorContext.mockResolvedValue({
      userId: "admin-1",
      isAuthenticated: true,
      userStatus: "ACTIVE",
      systemRole: "ADMIN",
      catalogId: "catalog-1",
      catalogExists: false,
      catalogGrant: null,
      hasCatalogAccess: false,
      isCatalogOwner: false,
      isCatalogAdmin: true,
      canEnterPortal: true,
    });

    const result = await resolveCatalogManagementActor("catalog-1", {
      activeCatalogOnly: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected access success");
    }
    expect(result.actor.catalogExists).toBe(false);
    expect(result.actor.isCatalogAdmin).toBe(true);
    expect(result.policyContext.catalogGrant).toBe(null);
    expect(canAttemptCatalogManagement(result.policyContext)).toBe(true);
    expect(resolveCatalogActorContext).toHaveBeenCalledWith("catalog-1", "admin-1", {
      activeCatalogOnly: false,
    });
  });
});
