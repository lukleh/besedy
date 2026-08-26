import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";

vi.mock("@/lib/auth/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/permissions")>();
  return {
    ...actual,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/policy/actor", () => ({
  resolveCatalogActorContext: vi.fn(),
  hasSystemCatalogAuthority: vi.fn(
    (actor: { systemRole?: string }) =>
      actor.systemRole === "ADMIN" || actor.systemRole === "SUPERADMIN"
  ),
}));

vi.mock("@/lib/features/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/features/capabilities")>();
  return {
    ...actual,
    getLabsPreferenceForUser: vi.fn(),
    isFeatureEnabledForUser: vi.fn(),
  };
});

describe("requireCatalogEventsAccess", () => {
  const catalogId = "20260201_120000";
  let requireAuth: ReturnType<typeof vi.fn>;
  let resolveCatalogActorContext: ReturnType<typeof vi.fn>;
  let getLabsPreferenceForUser: ReturnType<typeof vi.fn>;
  let isFeatureEnabledForUser: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;

    const actorModule = await import("@/lib/policy/actor");
    resolveCatalogActorContext =
      actorModule.resolveCatalogActorContext as ReturnType<typeof vi.fn>;

    const capabilitiesModule = await import("@/lib/features/capabilities");
    getLabsPreferenceForUser = capabilitiesModule.getLabsPreferenceForUser as ReturnType<
      typeof vi.fn
    >;
    isFeatureEnabledForUser = capabilitiesModule.isFeatureEnabledForUser as ReturnType<
      typeof vi.fn
    >;

    requireAuth.mockResolvedValue("user-1");
    getLabsPreferenceForUser.mockResolvedValue({ enabled: true, updatedAt: null });
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: "VIEWER",
      isCatalogAdmin: false,
    });
    isFeatureEnabledForUser.mockReturnValue(true);
  });

  it("returns 404 when catalog is missing or inactive", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: false,
      canEnterPortal: true,
      catalogGrant: null,
      isCatalogAdmin: false,
    });

    await expect(requireCatalogEventsAccess(catalogId, "view")).rejects.toMatchObject({
      name: "AuthError",
      message: "Catalog not found",
      statusCode: 404,
    });
  });

  it("prioritizes catalog 404 over feature and access 403 checks", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: false,
      canEnterPortal: true,
      catalogGrant: null,
      isCatalogAdmin: false,
    });
    isFeatureEnabledForUser.mockReturnValue(false);

    await expect(requireCatalogEventsAccess(catalogId, "view")).rejects.toMatchObject({
      name: "AuthError",
      message: "Catalog not found",
      statusCode: 404,
    });
  });

  it("returns 403 when the events feature is disabled", async () => {
    isFeatureEnabledForUser.mockReturnValue(false);

    await expect(requireCatalogEventsAccess(catalogId, "view")).rejects.toMatchObject({
      name: "AuthError",
      message: "Events feature is not enabled",
      statusCode: 403,
    });
  });

  it("returns 403 before feature/access checks when portal admission is inactive", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: false,
      catalogGrant: "OWNER",
      isCatalogAdmin: false,
    });
    isFeatureEnabledForUser.mockReturnValue(false);

    await expect(requireCatalogEventsAccess(catalogId, "view")).rejects.toMatchObject({
      name: "AuthError",
      message: "Portal access required",
      statusCode: 403,
    });
  });

  it("returns 403 when the user does not meet the events view access level", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: null,
      isCatalogAdmin: false,
    });

    await expect(requireCatalogEventsAccess(catalogId, "view")).rejects.toMatchObject({
      name: "AuthError",
      message: "Catalog access required: LISTENER or higher",
      statusCode: 403,
    });
  });

  it("keeps listener event access available for view mode", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: "LISTENER",
      isCatalogAdmin: false,
    });

    const result = await requireCatalogEventsAccess(catalogId, "view");

    expect(result).toMatchObject({
      userId: "user-1",
      accessLevel: "LISTENER",
      policyContext: {
        featureEnabled: true,
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: "LISTENER",
        isCatalogAdmin: false,
      },
    });
  });

  it("returns 403 for edit access when the user is neither owner nor admin", async () => {
    await expect(requireCatalogEventsAccess(catalogId, "edit")).rejects.toMatchObject({
      name: "AuthError",
      message: "Owner or admin access required for event edit operations",
      statusCode: 403,
    });
  });

  it("allows owners to edit events when the feature is enabled", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: "OWNER",
      isCatalogAdmin: false,
    });

    await expect(requireCatalogEventsAccess(catalogId, "edit")).resolves.toMatchObject({
      userId: "user-1",
      accessLevel: "OWNER",
      policyContext: {
        featureEnabled: true,
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: "OWNER",
        isCatalogAdmin: false,
      },
    });
  });

  it("checks feature gating before owner/admin edit checks", async () => {
    isFeatureEnabledForUser.mockReturnValue(false);

    await expect(requireCatalogEventsAccess(catalogId, "edit")).rejects.toMatchObject({
      name: "AuthError",
      message: "Events feature is not enabled",
      statusCode: 403,
    });
  });

  it("resolves catalog actor context with the authenticated user", async () => {
    await requireCatalogEventsAccess(catalogId, "view");

    expect(resolveCatalogActorContext).toHaveBeenCalledWith(
      catalogId,
      "user-1",
      {}
    );
  });

  it("returns user and accessLevel when all checks pass for view mode", async () => {
    const result = await requireCatalogEventsAccess(catalogId, "view");

    expect(result).toMatchObject({
      userId: "user-1",
      accessLevel: "VIEWER",
    });
  });

  it("returns user and accessLevel when admin passes edit mode", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: null,
      isCatalogAdmin: true,
    });

    const result = await requireCatalogEventsAccess(catalogId, "edit");

    expect(result).toMatchObject({
      userId: "user-1",
      accessLevel: null,
    });
  });

  it("returns action-specific denials for single-purpose event mutations", async () => {
    await expect(
      requireCatalogEventsAccess(catalogId, "attach_recording")
    ).rejects.toMatchObject({
      name: "AuthError",
      message: "Owner or admin access required to attach recordings to events",
      statusCode: 403,
    });
    await expect(
      requireCatalogEventsAccess(catalogId, "set_primary_recording")
    ).rejects.toMatchObject({
      name: "AuthError",
      message: "Owner or admin access required to set the primary recording",
      statusCode: 403,
    });
  });

  it("can opt into inactive catalog handling for settings-scoped event checks", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: "OWNER",
      isCatalogAdmin: false,
    });

    await requireCatalogEventsAccess(catalogId, "edit", {
      activeCatalogOnly: false,
    });

    expect(resolveCatalogActorContext).toHaveBeenCalledWith(catalogId, "user-1", {
      activeCatalogOnly: false,
    });
  });
});
