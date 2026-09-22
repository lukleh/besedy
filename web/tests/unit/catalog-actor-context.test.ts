import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCatalogActorContext } from "@/lib/policy/actor";

vi.mock("@/lib/db", () => ({
  default: {
    user: { findUnique: vi.fn() },
    workflowGroup: { findFirst: vi.fn() },
    catalogAccess: { findUnique: vi.fn() },
  },
}));

describe("catalog actor context", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const prisma = (await import("@/lib/db")).default;
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    } as never);
    vi.mocked(prisma.workflowGroup.findFirst).mockResolvedValue({
      id: "catalog-1",
    } as never);
  });

  it("recognizes a stored catalog_admin role as catalog administration", async () => {
    const prisma = (await import("@/lib/db")).default;
    vi.mocked(prisma.catalogAccess.findUnique).mockResolvedValue({
      role: "catalog_admin",
      extraPermissions: [],
      status: "ACTIVE",
    } as never);

    const actor = await resolveCatalogActorContext("catalog-1", "user-1");

    expect(actor).toMatchObject({
      catalogExists: true,
      hasCatalogAccess: true,
      isCatalogAdmin: true,
      catalogGrant: { role: "catalog_admin" },
    });
  });
});
