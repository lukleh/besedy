import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  requireCatalogManagementAccess,
  resolveCatalogManagementActor,
} from "@/lib/access/catalog-management-route-access";
import { canAttemptCatalogManagement } from "@/lib/policy/catalog";
import { canPublishRecording } from "@/lib/policy/recording";
import { canManageEventSources } from "@/lib/policy/event";
import { grantForRole } from "@/lib/policy/catalog-permissions";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/policy/actor", () => ({
  resolveCatalogActorContext: vi.fn(),
  hasSystemCatalogAuthority: vi.fn(
    (actor: { systemRole?: string }) =>
      actor.systemRole === "ADMIN" || actor.systemRole === "SUPERADMIN"
  ),
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
      deniedMessage: "Publish-recording permission required to change recording publication state",
      deniedReason: "Publish-recording permission required to change recording publication state",
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
      catalogGrant: grantForRole("reader"),
      isCatalogAdmin: false,
    });

    const result = await requireCatalogManagementAccess("catalog-1", {
      auditResource: "catalog_settings",
      auditResourceId: "catalog-1",
      deniedMessage: "Admin access required to view catalog settings",
      deniedReason: "Admin access required to view catalog settings",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected access failure");
    }
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({
      error: "Admin access required to view catalog settings",
      code: "FORBIDDEN",
    });
    expect(logAccessDenied).toHaveBeenCalledWith(
      "user-1",
      "catalog_settings",
      "catalog-1",
      {
        catalogId: "catalog-1",
        reason: "Admin access required to view catalog settings",
      }
    );
  });

  it("supports route-specific authorization predicates", async () => {
    requireAuth.mockResolvedValue("curator-1");
    // The predicate replaces the management check: a curator carries
    // publish_recording without manage_access and still gets through.
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("curator"),
      isCatalogAdmin: false,
    });

    const result = await requireCatalogManagementAccess("catalog-1", {
      auditResource: "catalog_publication",
      auditResourceId: "hash-1",
      deniedMessage: "Publish-recording permission required to change recording publication state",
      deniedReason: "Publish-recording permission required to change recording publication state",
      authorize: canPublishRecording,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected access success");
    }
    expect(result.userId).toBe("curator-1");
    expect(result.policyContext.catalogGrant).toEqual(grantForRole("curator"));
  });

  // The gate is enforced here, not only in the payload the list reads, so the
  // other side of the role split is asserted against the route helper itself:
  // the curator case above passes, a host carrying manage_access does not.
  it("refuses a host at the publication gate despite manage_access", async () => {
    requireAuth.mockResolvedValue("host-1");
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("host"),
      isCatalogAdmin: false,
    });

    const result = await requireCatalogManagementAccess("catalog-1", {
      auditResource: "catalog_publication",
      auditResourceId: "hash-1",
      deniedMessage: "Publish-recording permission required to change recording publication state",
      deniedReason: "Publish-recording permission required to change recording publication state",
      authorize: canPublishRecording,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected access failure");
    }
    expect(result.response.status).toBe(403);
    expect(logAccessDenied).toHaveBeenCalledWith(
      "host-1",
      "catalog_publication",
      "hash-1",
      {
        catalogId: "catalog-1",
        reason: "Publish-recording permission required to change recording publication state",
      }
    );
  });

  // Sources went the other way round: the default predicate let the host
  // through and refused the curator. Both directions against the helper, so
  // neither role can drift back onto the default.
  it("refuses a host at the sources gate despite manage_access", async () => {
    requireAuth.mockResolvedValue("host-1");
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("host"),
      isCatalogAdmin: false,
    });

    const result = await requireCatalogManagementAccess("catalog-1", {
      auditResource: "event_sources",
      auditResourceId: "12",
      deniedMessage: "Event-sources permission required to manage event sources",
      deniedReason: "Event-sources permission required to manage event sources",
      authorize: canManageEventSources,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected access failure");
    }
    expect(result.response.status).toBe(403);
    expect(logAccessDenied).toHaveBeenCalledWith(
      "host-1",
      "event_sources",
      "12",
      {
        catalogId: "catalog-1",
        reason: "Event-sources permission required to manage event sources",
      }
    );
  });

  it("admits a curator at the sources gate without manage_access", async () => {
    requireAuth.mockResolvedValue("curator-1");
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("curator"),
      isCatalogAdmin: false,
    });

    const result = await requireCatalogManagementAccess("catalog-1", {
      auditResource: "event_sources",
      auditResourceId: "12",
      deniedMessage: "Event-sources permission required to manage event sources",
      deniedReason: "Event-sources permission required to manage event sources",
      authorize: canManageEventSources,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected access success");
    }
    expect(result.userId).toBe("curator-1");
    expect(logAccessDenied).not.toHaveBeenCalled();
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
