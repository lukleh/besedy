import { describe, expect, it } from "vitest";
import { catalogFeaturesResponseSchema } from "@/hooks/use-catalog-features";

const current = { features: { events: { canView: true, canEdit: false, showTabs: false, showAllColumns: false, showReleaseState: false, canUseRagSearch: false }, recordings: { canBrowse: false } } };

describe("current catalog feature response", () => {
  it("requires explicit current capabilities", () => {
    expect(catalogFeaturesResponseSchema.safeParse(current).success).toBe(true);
    expect(catalogFeaturesResponseSchema.safeParse({ features: { events: current.features.events } }).success).toBe(false);
    expect(catalogFeaturesResponseSchema.safeParse({ features: { ...current.features, recordings: {} } }).success).toBe(false);
  });
});
