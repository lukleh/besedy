import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveReadableGroup } from "@/lib/catalog/resolve-readable-group";
import { getCatalogDiscoveryCapability } from "@/lib/access/capabilities";

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogDiscoveryCapability: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    userPreferences: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    workflowGroup: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

describe("resolveReadableGroup", () => {
  let prisma: {
    userPreferences: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    workflowGroup: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    vi.mocked(getCatalogDiscoveryCapability).mockResolvedValue({
      userId: "user-1",
      isAuthenticated: true,
      userStatus: "ACTIVE",
      canEnterPortal: true,
      accessibleCatalogIds: ["catalog-a", "catalog-b"],
      canDiscoverCatalogs: true,
    });
    prisma.userPreferences.findUnique.mockResolvedValue({
      activeGroupId: "catalog-b",
    });
    prisma.workflowGroup.findMany.mockResolvedValue([
      { id: "catalog-b", isActive: true, isDefault: false },
      { id: "catalog-a", isActive: true, isDefault: true },
    ]);
  });

  it("uses an accessible explicit catalog without changing preferences", async () => {
    await expect(
      resolveReadableGroup("catalog-a", "user-1")
    ).resolves.toMatchObject({
      source: "explicit",
      group: { id: "catalog-a" },
    });

    expect(prisma.userPreferences.upsert).not.toHaveBeenCalled();
    expect(prisma.userPreferences.update).not.toHaveBeenCalled();
  });

  it("rejects an explicit catalog outside the user's accessible set", async () => {
    await expect(
      resolveReadableGroup("catalog-private", "user-1")
    ).resolves.toBeNull();

    expect(prisma.workflowGroup.findMany).not.toHaveBeenCalled();
    expect(prisma.userPreferences.findUnique).not.toHaveBeenCalled();
  });

  it("prefers the user's saved accessible catalog when no catalog is given", async () => {
    await expect(
      resolveReadableGroup(undefined, "user-1")
    ).resolves.toMatchObject({
      source: "preference",
      group: { id: "catalog-b" },
    });
  });

  it("falls back to the accessible global default and then the most recent catalog", async () => {
    prisma.userPreferences.findUnique.mockResolvedValue({
      activeGroupId: "catalog-stale",
    });

    await expect(
      resolveReadableGroup(undefined, "user-1")
    ).resolves.toMatchObject({
      source: "default",
      group: { id: "catalog-a" },
    });

    prisma.workflowGroup.findMany.mockResolvedValue([
      { id: "catalog-b", isActive: true, isDefault: false },
      { id: "catalog-a", isActive: true, isDefault: false },
    ]);

    await expect(
      resolveReadableGroup(undefined, "user-1")
    ).resolves.toMatchObject({
      source: "recent",
      group: { id: "catalog-b" },
    });
  });

  it("returns null for an inactive user or a user without catalogs", async () => {
    vi.mocked(getCatalogDiscoveryCapability).mockResolvedValue({
      userId: "blocked-1",
      isAuthenticated: true,
      userStatus: "BLOCKED",
      canEnterPortal: false,
      accessibleCatalogIds: [],
      canDiscoverCatalogs: false,
    });

    await expect(
      resolveReadableGroup(undefined, "blocked-1")
    ).resolves.toBeNull();
    expect(prisma.workflowGroup.findMany).not.toHaveBeenCalled();
  });
});
