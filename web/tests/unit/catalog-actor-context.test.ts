import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasSystemAdminAuthority,
  resolveCatalogActorContext,
} from "@/lib/policy/actor";

vi.mock("@/lib/db", () => ({
  default: {
    user: { findUnique: vi.fn() },
    workflowGroup: { findFirst: vi.fn(), findUnique: vi.fn() },
    catalogAccess: { findUnique: vi.fn() },
  },
}));

describe("catalog actor context", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("BESEDY_ARCHIVE_ID", "20251225_120000");
    const prisma = (await import("@/lib/db")).default;
    vi.mocked(prisma.workflowGroup.findUnique).mockResolvedValue({ id: "20251225_120000", isActive: true } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      status: "ACTIVE",
      isAdmin: false,
      isSuperadmin: false,
    } as never);
    vi.mocked(prisma.workflowGroup.findFirst).mockResolvedValue({
      id: "20251225_120000",
    } as never);
  });

  it("recognizes a stored catalog_admin role as catalog administration", async () => {
    const prisma = (await import("@/lib/db")).default;
    vi.mocked(prisma.catalogAccess.findUnique).mockResolvedValue({
      role: "catalog_admin",
      extraPermissions: [],
      status: "ACTIVE",
    } as never);

    const actor = await resolveCatalogActorContext("20251225_120000", "user-1");

    expect(actor).toMatchObject({
      catalogExists: true,
      hasCatalogAccess: true,
      isCatalogAdmin: true,
      catalogGrant: { role: "catalog_admin" },
    });
  });
});

describe("hasSystemAdminAuthority", () => {
  it.each([
    ["SUPERADMIN", true, true],
    ["ADMIN", true, true],
    ["USER", true, false],
    // A blocked or pending admin keeps the role but loses the authority.
    ["ADMIN", false, false],
    ["SUPERADMIN", false, false],
  ] as const)("%s with portal entry %s is %s", (systemRole, canEnterPortal, expected) => {
    expect(hasSystemAdminAuthority({ systemRole, canEnterPortal })).toBe(expected);
  });
});
