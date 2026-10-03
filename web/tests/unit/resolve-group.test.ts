import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, getAdminCapability, getCatalogCapability, getCatalogDiscoveryCapability } =
  vi.hoisted(() => ({
    prismaMock: {
      workflowGroup: { findFirst: vi.fn() },
      userPreferences: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    },
    getAdminCapability: vi.fn(),
    getCatalogCapability: vi.fn(),
    getCatalogDiscoveryCapability: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({ default: prismaMock }));
vi.mock("@/lib/access/capabilities", () => ({
  getAdminCapability,
  getCatalogCapability,
  getCatalogDiscoveryCapability,
}));

import { resolveActiveGroup, resolveActiveGroupWithAccess } from "@/lib/catalog/resolve-group";

const CATALOG_A = "20250101_120000";
const CATALOG_B = "20250202_120000";

describe("resolveActiveGroup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAdminCapability.mockResolvedValue({ canAccessAdmin: false });
    getCatalogCapability.mockResolvedValue({ hasAccess: true });
    getCatalogDiscoveryCapability.mockResolvedValue({ accessibleCatalogIds: [] });
    prismaMock.userPreferences.findUnique.mockResolvedValue(null);
  });

  it("returns the explicit group without writing the user's preferences", async () => {
    prismaMock.workflowGroup.findFirst.mockResolvedValue({ id: CATALOG_B, isActive: true });

    const group = await resolveActiveGroup(CATALOG_B, "user-1");

    expect(group).toEqual({ id: CATALOG_B, isActive: true });
    expect(prismaMock.userPreferences.upsert).not.toHaveBeenCalled();
    expect(prismaMock.userPreferences.update).not.toHaveBeenCalled();
  });

  it("returns the explicit group even without access, for an access-denied answer", async () => {
    getCatalogCapability.mockResolvedValue({ hasAccess: false });
    prismaMock.workflowGroup.findFirst.mockResolvedValue({ id: CATALOG_B, isActive: true });

    await expect(resolveActiveGroupWithAccess(CATALOG_B, "user-1")).resolves.toEqual({
      group: { id: CATALOG_B, isActive: true },
      hasAccess: false,
    });
    expect(prismaMock.userPreferences.upsert).not.toHaveBeenCalled();
  });

  it("still resolves the saved active group when no group is given", async () => {
    prismaMock.userPreferences.findUnique.mockResolvedValue({
      activeGroup: { id: CATALOG_A, isActive: true },
    });

    const group = await resolveActiveGroup(null, "user-1");

    expect(group).toEqual({ id: CATALOG_A, isActive: true });
    expect(prismaMock.workflowGroup.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.userPreferences.upsert).not.toHaveBeenCalled();
  });

  it("falls back to the default catalog when nothing is saved", async () => {
    prismaMock.workflowGroup.findFirst.mockResolvedValue({ id: CATALOG_A, isDefault: true });

    const group = await resolveActiveGroup(undefined, "user-1");

    expect(group).toEqual({ id: CATALOG_A, isDefault: true });
    expect(prismaMock.userPreferences.upsert).not.toHaveBeenCalled();
  });
});
