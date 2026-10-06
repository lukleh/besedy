import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, getAdminCapability, getCatalogCapability } = vi.hoisted(() => ({
  prismaMock: {
    workflowGroup: { findFirst: vi.fn() },
    userPreferences: { findUnique: vi.fn() },
  },
  getAdminCapability: vi.fn(),
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ default: prismaMock }));
vi.mock("@/lib/access/capabilities", () => ({ getAdminCapability, getCatalogCapability }));

import { findActiveCatalog, resolveCatalogWithAccess } from "@/lib/catalog/resolve-group";

const CATALOG = "20250101_120000";

describe("findActiveCatalog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads only the active catalog the path names", async () => {
    prismaMock.workflowGroup.findFirst.mockResolvedValue({ id: CATALOG, isActive: true });

    await expect(findActiveCatalog(CATALOG)).resolves.toEqual({ id: CATALOG, isActive: true });
    expect(prismaMock.workflowGroup.findFirst).toHaveBeenCalledWith({
      where: { id: CATALOG, isActive: true },
    });
  });

  it("never falls back to another catalog when the named one is missing", async () => {
    prismaMock.workflowGroup.findFirst.mockResolvedValue(null);

    await expect(findActiveCatalog(CATALOG)).resolves.toBeNull();
    expect(prismaMock.workflowGroup.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.userPreferences.findUnique).not.toHaveBeenCalled();
  });
});

describe("resolveCatalogWithAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.workflowGroup.findFirst.mockResolvedValue({ id: CATALOG, isActive: true });
    getAdminCapability.mockResolvedValue({ canAccessAdmin: false });
    getCatalogCapability.mockResolvedValue({ hasAccess: false });
  });

  it("reports no catalog and no access for a missing catalog", async () => {
    prismaMock.workflowGroup.findFirst.mockResolvedValue(null);

    await expect(resolveCatalogWithAccess(CATALOG, "user-1")).resolves.toEqual({
      group: null,
      hasAccess: false,
    });
  });

  it("grants access with a catalog grant", async () => {
    getCatalogCapability.mockResolvedValue({ hasAccess: true });

    const result = await resolveCatalogWithAccess(CATALOG, "user-1");

    expect(result.hasAccess).toBe(true);
    expect(getCatalogCapability).toHaveBeenCalledWith(CATALOG, "user-1");
  });

  it("grants admins access without a catalog grant", async () => {
    getAdminCapability.mockResolvedValue({ canAccessAdmin: true });

    await expect(resolveCatalogWithAccess(CATALOG, "admin-1")).resolves.toMatchObject({
      hasAccess: true,
    });
  });

  it("returns the catalog without access, so callers can answer access denied", async () => {
    await expect(resolveCatalogWithAccess(CATALOG, "user-1")).resolves.toEqual({
      group: { id: CATALOG, isActive: true },
      hasAccess: false,
    });
  });
});
