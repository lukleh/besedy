import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { grantForRole } from "@/lib/policy/catalog-permissions";

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

describe("requireCatalogEventsAccess", () => {
  const catalogId = "20260201_120000";
  let requireAuth: ReturnType<typeof vi.fn>;
  let resolveCatalogActorContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;

    const actorModule = await import("@/lib/policy/actor");
    resolveCatalogActorContext =
      actorModule.resolveCatalogActorContext as ReturnType<typeof vi.fn>;

    requireAuth.mockResolvedValue("user-1");
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("reader"),
      isCatalogAdmin: false,
    });
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

  it("returns 403 when portal admission is inactive", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: false,
      catalogGrant: grantForRole("host"),
      isCatalogAdmin: false,
    });

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
      message: "Catalog access required",
      statusCode: 403,
    });
  });

  it("keeps listener event access available for view mode", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("listener"),
      isCatalogAdmin: false,
    });

    const result = await requireCatalogEventsAccess(catalogId, "view");

    expect(result).toMatchObject({
      userId: "user-1",
      catalogGrant: grantForRole("listener"),
      policyContext: {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: grantForRole("listener"),
        isCatalogAdmin: false,
      },
    });
  });

  it("returns 403 for edit access when the user lacks manage_events", async () => {
    await expect(requireCatalogEventsAccess(catalogId, "edit")).rejects.toMatchObject({
      name: "AuthError",
      message: "Event-management permission required for event edit operations",
      statusCode: 403,
    });
  });

  it("allows curators to edit events", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("curator"),
      isCatalogAdmin: false,
    });

    await expect(requireCatalogEventsAccess(catalogId, "edit")).resolves.toMatchObject({
      userId: "user-1",
      catalogGrant: grantForRole("curator"),
      policyContext: {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: grantForRole("curator"),
        isCatalogAdmin: false,
      },
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

  it("returns user and catalogGrant when all checks pass for view mode", async () => {
    const result = await requireCatalogEventsAccess(catalogId, "view");

    expect(result).toMatchObject({
      userId: "user-1",
      catalogGrant: grantForRole("reader"),
    });
  });

  it("returns user and catalogGrant when admin passes edit mode", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: null,
      isCatalogAdmin: true,
    });

    const result = await requireCatalogEventsAccess(catalogId, "edit");

    expect(result).toMatchObject({
      userId: "user-1",
      catalogGrant: null,
    });
  });

  it("returns action-specific denials for single-purpose event mutations", async () => {
    await expect(
      requireCatalogEventsAccess(catalogId, "attach_recording")
    ).rejects.toMatchObject({
      name: "AuthError",
      message: "Event-management permission required to attach recordings to events",
      statusCode: 403,
    });
    await expect(
      requireCatalogEventsAccess(catalogId, "set_primary_recording")
    ).rejects.toMatchObject({
      name: "AuthError",
      message: "Event-management permission required to set the primary recording",
      statusCode: 403,
    });
  });

  it("can opt into inactive catalog handling for settings-scoped event checks", async () => {
    resolveCatalogActorContext.mockResolvedValue({
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("curator"),
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
