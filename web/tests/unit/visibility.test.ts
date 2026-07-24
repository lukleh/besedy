import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessibleWorkflowGroups } from "@/lib/auth/visibility";

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogDiscoveryCapability: vi.fn(),
}));

describe("getAccessibleWorkflowGroups", () => {
  let getCatalogDiscoveryCapability: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    const accessModule = await import("@/lib/access/capabilities");
    getCatalogDiscoveryCapability =
      accessModule.getCatalogDiscoveryCapability as ReturnType<typeof vi.fn>;
  });

  it("returns empty array when discovery capability has no accessible catalogs", async () => {
    getCatalogDiscoveryCapability.mockResolvedValue({
      accessibleCatalogIds: [],
    });

    const result = await getAccessibleWorkflowGroups();

    expect(result).toEqual([]);
    expect(getCatalogDiscoveryCapability).toHaveBeenCalledWith(undefined);
  });

  it("maps discovery capability catalog ids directly", async () => {
    getCatalogDiscoveryCapability.mockResolvedValue({
      accessibleCatalogIds: ["catalog-1", "catalog-2"],
    });

    const result = await getAccessibleWorkflowGroups("user-1");

    expect(result).toEqual(["catalog-1", "catalog-2"]);
    expect(getCatalogDiscoveryCapability).toHaveBeenCalledWith("user-1");
  });
});
