import { describe, expect, it } from "vitest";
import { buildCatalogFeaturesResponse } from "@/lib/features/capabilities";

function deepSearch(enabled: boolean, canView: boolean) {
  return {
    rollout: "labs",
    enabled,
    canView,
  };
}

describe("event capabilities", () => {
  it("keeps listeners on the events-first view without a tab switcher", () => {
    const result = buildCatalogFeaturesResponse("LISTENER", false, false);

    expect(result).toEqual({
      labsEnabled: false,
      features: {
        events: {
          rollout: "public",
          enabled: true,
          canView: true,
          canEdit: false,
          showTabs: false,
          showAllColumns: false,
          showReleaseState: false,
        },
        deepSearch: deepSearch(false, false),
      },
    });
  });

  it("keeps viewers on the events-first view without a tab switcher", () => {
    const result = buildCatalogFeaturesResponse("VIEWER", false, false);

    expect(result).toEqual({
      labsEnabled: false,
      features: {
        events: {
          rollout: "public",
          enabled: true,
          canView: true,
          canEdit: false,
          showTabs: false,
          showAllColumns: false,
          showReleaseState: true,
        },
        deepSearch: deepSearch(false, false),
      },
    });
  });

  it("lets owners edit events and use both catalog tabs", () => {
    const result = buildCatalogFeaturesResponse("OWNER", false, false);

    expect(result).toEqual({
      labsEnabled: false,
      features: {
        events: {
          rollout: "public",
          enabled: true,
          canView: true,
          canEdit: true,
          showTabs: true,
          showAllColumns: true,
          showReleaseState: true,
        },
        deepSearch: deepSearch(false, false),
      },
    });
  });

  it("lets owners use deep search only when Labs is enabled", () => {
    const result = buildCatalogFeaturesResponse("OWNER", true, false);

    expect(result.features.deepSearch).toEqual(deepSearch(true, true));
  });

  it("lets catalog admins browse and edit events without an explicit catalog grant", () => {
    const result = buildCatalogFeaturesResponse(null, false, true);

    expect(result).toEqual({
      labsEnabled: false,
      features: {
        events: {
          rollout: "public",
          enabled: true,
          canView: true,
          canEdit: true,
          showTabs: true,
          showAllColumns: true,
          showReleaseState: true,
        },
        deepSearch: deepSearch(false, false),
      },
    });
  });

  it("lets system catalog admins use deep search only when Labs is enabled", () => {
    const result = buildCatalogFeaturesResponse(null, true, true);

    expect(result.features.deepSearch).toEqual(deepSearch(true, true));
  });

  it("keeps rollout enabled while denying event access when the user lacks catalog access", () => {
    const result = buildCatalogFeaturesResponse(null, false, false);

    expect(result).toEqual({
      labsEnabled: false,
      features: {
        events: {
          rollout: "public",
          enabled: true,
          canView: false,
          canEdit: false,
          showTabs: false,
          showAllColumns: false,
          showReleaseState: false,
        },
        deepSearch: deepSearch(false, false),
      },
    });
  });

  it("never reports event access when admission or catalog state is impossible", () => {
    const result = buildCatalogFeaturesResponse("LISTENER", true, false, {
      catalogExists: false,
      canEnterPortal: false,
    });

    expect(result).toEqual({
      labsEnabled: true,
      features: {
        events: {
          rollout: "public",
          enabled: true,
          canView: false,
          canEdit: false,
          showTabs: false,
          showAllColumns: false,
          showReleaseState: false,
        },
        deepSearch: deepSearch(true, false),
      },
    });
  });
});
