import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, getAdminCapability, getCatalogCapability } = vi.hoisted(() => ({
  prismaMock: {
    workflowGroup: { findFirst: vi.fn(), findUnique: vi.fn() },
    userPreferences: { findUnique: vi.fn() },
  },
  getAdminCapability: vi.fn(),
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ default: prismaMock }));
vi.mock("@/lib/access/capabilities", () => ({ getAdminCapability, getCatalogCapability }));

import { findActiveCatalog, resolveCatalogWithAccess } from "@/lib/catalog/resolve-group";
import { ArchiveConfigurationError } from "@/lib/archive";

const CATALOG = "20250101_120000";

beforeEach(() => {
  vi.stubEnv("BESEDY_ARCHIVE_ID", CATALOG);
  prismaMock.workflowGroup.findUnique.mockResolvedValue({
    id: CATALOG, label: "Archive", isActive: true,
  });
});

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

  it.each(["20260101_120000", "20260102_120000"])(
    "does not let admin authority reopen foreign source %s",
    async (foreignId) => {
      prismaMock.workflowGroup.findFirst.mockResolvedValue({ id: foreignId, isActive: true });
      getAdminCapability.mockResolvedValue({ canAccessAdmin: true });

      await expect(resolveCatalogWithAccess(foreignId, "admin-1")).resolves.toEqual({
        group: null, hasAccess: false,
      });
      expect(prismaMock.workflowGroup.findFirst).not.toHaveBeenCalled();
      expect(getAdminCapability).not.toHaveBeenCalled();
      expect(getCatalogCapability).not.toHaveBeenCalled();
    }
  );
});

describe("active catalog archive scope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hides a foreign source from callers that perform their own access check", async () => {
    prismaMock.workflowGroup.findFirst.mockResolvedValue({ id: "20260101_120000", isActive: true });
    await expect(findActiveCatalog("20260101_120000")).resolves.toBeNull();
    expect(prismaMock.workflowGroup.findFirst).not.toHaveBeenCalled();
  });

  it.each([null, { id: CATALOG, isActive: false }])(
    "does not disguise missing or inactive archive configuration as a missing request target",
    async (archive) => {
      prismaMock.workflowGroup.findUnique.mockResolvedValue(archive);
      await expect(findActiveCatalog(CATALOG)).rejects.toThrow(ArchiveConfigurationError);
      expect(prismaMock.workflowGroup.findFirst).not.toHaveBeenCalled();
    }
  );

  it("propagates malformed configuration", async () => {
    vi.stubEnv("BESEDY_ARCHIVE_ID", "newest");
    await expect(findActiveCatalog(CATALOG)).rejects.toThrow(ArchiveConfigurationError);
    expect(prismaMock.workflowGroup.findFirst).not.toHaveBeenCalled();
  });

  it("propagates database failures", async () => {
    const error = new Error("database unavailable");
    prismaMock.workflowGroup.findUnique.mockRejectedValueOnce(error);
    await expect(findActiveCatalog(CATALOG)).rejects.toBe(error);
  });
});
