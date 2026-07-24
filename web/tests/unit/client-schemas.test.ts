import { describe, expect, it } from "vitest";
import { preferencesResponseSchema } from "@/lib/preferences/client-schema";
import { catalogSchema } from "@/hooks/use-catalogs";

describe("client response schemas", () => {
  it("rejects unexpected keys in preferences payloads", () => {
    const result = preferencesResponseSchema.safeParse({
      userId: "user-1",
      activeGroupId: null,
      activeGroup: null,
      theme: "system",
      catalogColumns: [],
      settings: {},
      extra: true,
    });

    expect(result.success).toBe(false);
  });

  it("requires the full catalog payload shape instead of stripping fields", () => {
    const result = catalogSchema.safeParse({
      id: "20251201_143022",
      label: "Winter",
      archivedCatalogPath: "/archived.csv",
      metadataCatalogPath: "/metadata.csv",
      transcriptsPath: "/transcripts",
      isDefault: false,
      isActive: true,
    });

    expect(result.success).toBe(false);
  });
});
