import { describe, expect, it } from "vitest";
import { preferencesResponseSchema } from "@/lib/preferences/client-schema";
import { catalogFeaturesResponseSchema } from "@/hooks/use-catalog-features";

describe("client response schemas", () => {
  it("rejects unexpected keys in preferences payloads", () => {
    const result = preferencesResponseSchema.safeParse({
      userId: "user-1",
      theme: "system",
      catalogColumns: [],
      settings: {},
      extra: true,
    });

    expect(result.success).toBe(false);
  });

  it('rejects a response missing the current RAG capability', () => {
    const result = catalogFeaturesResponseSchema.safeParse({
      features: {
        events: {
          canView: true,
          canEdit: false,
          showTabs: true,
          showAllColumns: false,
          showReleaseState: false,
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
