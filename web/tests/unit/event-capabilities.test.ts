import { describe, expect, it } from "vitest";
import { buildCatalogFeaturesResponse } from "@/lib/features/capabilities";
import { grantForRole, grantFromLevel } from "@/lib/policy/catalog-permissions";

function deepSearch(enabled: boolean, canView: boolean) {
  return {
    rollout: "labs",
    enabled,
    canView,
  };
}

describe("event capabilities", () => {
  // Browsing recordings is a permission now, and no role below the curator
  // carries it, so these two have one surface and need no switch.
  it("keeps listeners on the events-first view without a tab switcher", () => {
    const result = buildCatalogFeaturesResponse(
      grantForRole("listener"),
      false,
      false
    );

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
          canUseRagSearch: false,
        },
        recordings: { canBrowse: false },
        deepSearch: deepSearch(false, false),
      },
    });
  });

  it("keeps readers on the events-first view without a tab switcher", () => {
    const result = buildCatalogFeaturesResponse(
      grantForRole("reader"),
      false,
      false
    );

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
          // A reader reads; seeing unreleased material is a curator's, so the
          // release-state indicator has nothing to indicate.
          showReleaseState: false,
          canUseRagSearch: true,
        },
        recordings: { canBrowse: false },
        deepSearch: deepSearch(false, false),
      },
    });
  });

  it("lets owners edit events and use both catalog tabs", () => {
    const result = buildCatalogFeaturesResponse(
      grantFromLevel("OWNER"),
      false,
      false
    );

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
          canUseRagSearch: true,
        },
        recordings: { canBrowse: true },
        deepSearch: deepSearch(false, false),
      },
    });
  });

  it("lets owners use deep search only when Labs is enabled", () => {
    const result = buildCatalogFeaturesResponse(
      grantFromLevel("OWNER"),
      true,
      false
    );

    expect(result.features.deepSearch).toEqual(deepSearch(true, true));
  });

  it("requires transcript read permission for deep search", () => {
    const result = buildCatalogFeaturesResponse(
      {
        level: null,
        role: "listener",
        extras: ["use_deep_search"],
      },
      true,
      false
    );

    expect(result.features.deepSearch).toEqual(deepSearch(true, false));
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
          canUseRagSearch: true,
        },
        recordings: { canBrowse: true },
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
          canUseRagSearch: false,
        },
        recordings: { canBrowse: false },
        deepSearch: deepSearch(false, false),
      },
    });
  });

  it("never reports event access when admission or catalog state is impossible", () => {
    const result = buildCatalogFeaturesResponse(
      grantFromLevel("LISTENER"),
      true,
      false,
      {
        catalogExists: false,
        canEnterPortal: false,
      }
    );

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
          canUseRagSearch: false,
        },
        recordings: { canBrowse: false },
        deepSearch: deepSearch(true, false),
      },
    });
  });
});
