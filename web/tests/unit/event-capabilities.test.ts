import { describe, expect, it } from "vitest";
import { buildCatalogFeaturesResponse } from "@/lib/features/capabilities";
import { grantForRole } from "@/lib/policy/catalog-permissions";

describe("event capabilities", () => {
  // Browsing recordings is a permission now, and no role below the curator
  // carries it, so these two have one surface and need no switch.
  it("keeps listeners on the events-first view without a tab switcher", () => {
    const result = buildCatalogFeaturesResponse(
      grantForRole("listener"),
      false
    );

    expect(result).toEqual({
      features: {
        events: {
          canView: true,
          canEdit: false,
          showTabs: false,
          showAllColumns: false,
          showReleaseState: false,
          canUseRagSearch: false,
        },
        recordings: { canBrowse: false },
      },
    });
  });

  it("keeps readers on the events-first view without a tab switcher", () => {
    const result = buildCatalogFeaturesResponse(
      grantForRole("reader"),
      false
    );

    expect(result).toEqual({
      features: {
        events: {
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
      },
    });
  });

  it("lets curators edit events and use both catalog tabs", () => {
    const result = buildCatalogFeaturesResponse(
      grantForRole("curator"),
      false
    );

    expect(result).toEqual({
      features: {
        events: {
          canView: true,
          canEdit: true,
          showTabs: true,
          showAllColumns: true,
          showReleaseState: true,
          canUseRagSearch: true,
        },
        recordings: { canBrowse: true },
      },
    });
  });

  it("lets catalog admins browse and edit events without an explicit catalog grant", () => {
    const result = buildCatalogFeaturesResponse(null, true);

    expect(result).toEqual({
      features: {
        events: {
          canView: true,
          canEdit: true,
          showTabs: true,
          showAllColumns: true,
          showReleaseState: true,
          canUseRagSearch: true,
        },
        recordings: { canBrowse: true },
      },
    });
  });

  it("denies event access when the user lacks catalog access", () => {
    const result = buildCatalogFeaturesResponse(null, false);

    expect(result).toEqual({
      features: {
        events: {
          canView: false,
          canEdit: false,
          showTabs: false,
          showAllColumns: false,
          showReleaseState: false,
          canUseRagSearch: false,
        },
        recordings: { canBrowse: false },
      },
    });
  });

  it("never reports event access when admission or catalog state is impossible", () => {
    const result = buildCatalogFeaturesResponse(
      grantForRole("listener"),
      false,
      {
        catalogExists: false,
        canEnterPortal: false,
      }
    );

    expect(result).toEqual({
      features: {
        events: {
          canView: false,
          canEdit: false,
          showTabs: false,
          showAllColumns: false,
          showReleaseState: false,
          canUseRagSearch: false,
        },
        recordings: { canBrowse: false },
      },
    });
  });
});
