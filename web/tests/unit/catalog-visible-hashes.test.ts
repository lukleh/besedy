import { beforeEach, describe, expect, it, vi } from "vitest";
import { grantForRole, grantFromLevel } from "@/lib/policy/catalog-permissions";

vi.mock("@/lib/db", () => ({
  default: {
    catalogEntry: {
      findMany: vi.fn(),
    },
  },
}));

const ENTRIES = [
  { audioHash: "published", isActionable: true, isPublished: true },
  { audioHash: "unpublished", isActionable: true, isPublished: false },
  { audioHash: "incomplete", isActionable: false, isPublished: true },
];

describe("loadVisibleCatalogHashes", () => {
  let prisma: { catalogEntry: { findMany: ReturnType<typeof vi.fn> } };
  let loadVisibleCatalogHashes: typeof import("@/lib/catalog")["loadVisibleCatalogHashes"];

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    loadVisibleCatalogHashes = (await import("@/lib/catalog"))
      .loadVisibleCatalogHashes;
    prisma.catalogEntry.findMany.mockResolvedValue(ENTRIES);
  });

  // Delivery is never broader than reading: what an export hands over has to be
  // what the same account could have opened one recording at a time.
  it("gives an account without unreleased visibility only what it could open", async () => {
    const hashes = await loadVisibleCatalogHashes(
      "catalog-1",
      grantForRole("listener")
    );

    expect([...hashes]).toEqual(["published"]);
  });

  it("gives an account that sees unreleased material everything", async () => {
    const hashes = await loadVisibleCatalogHashes(
      "catalog-1",
      grantForRole("curator")
    );

    expect([...hashes].sort()).toEqual([
      "incomplete",
      "published",
      "unpublished",
    ]);
  });

  it("gives a catalog administrator everything", async () => {
    // A null grant is how an administrator reaches this: unscoped by design.
    const hashes = await loadVisibleCatalogHashes("catalog-1", null);

    expect(hashes.size).toBe(3);
  });

  it("scopes a legacy level grant the same way its role would", async () => {
    expect([...(await loadVisibleCatalogHashes("c", grantFromLevel("LISTENER")))])
      .toEqual(["published"]);
    expect(
      (await loadVisibleCatalogHashes("c", grantFromLevel("EDITOR"))).size
    ).toBe(3);
  });
});
