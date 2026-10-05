import { describe, expect, it } from "vitest";
import { buildCatalogRouteState } from "@/hooks/use-catalog-route-state";
import { resolveEffectiveCatalogId } from "@/hooks/use-effective-catalog-id";

const LABELS = {
  back: "Back",
  backToCatalog: "Back to catalog",
  backToRecording: "Back to recording",
  backToEvent: "Back to event",
};

describe("catalog route state helpers", () => {
  it("builds recording subpage navigation state", () => {
    const result = buildCatalogRouteState(
      "/catalog/20260101_120000/recording/hash123/edit",
      LABELS
    );

    expect(result.routeGroupId).toBe("20260101_120000");
    expect(result.backTargetUrl).toBe("/catalog/20260101_120000/recording/hash123");
    expect(result.backTargetLabel).toBe("Back to recording");
  });

  it("builds event detail navigation state", () => {
    const result = buildCatalogRouteState(
      "/catalog/20260101_120000/event/event-1",
      LABELS
    );

    expect(result.routeGroupId).toBe("20260101_120000");
    expect(result.backTargetUrl).toBe("/catalog/20260101_120000?tab=events");
    expect(result.backTargetLabel).toBe("Back to catalog");
  });

  it("uses an explicit back target for recording detail routes", () => {
    const result = buildCatalogRouteState(
      "/catalog/20260101_120000/recording/hash123",
      LABELS,
      { backToPath: "/catalog/20260101_120000/events/unassigned" }
    );

    expect(result.backTargetUrl).toBe("/catalog/20260101_120000/events/unassigned");
    expect(result.backTargetLabel).toBe("Back");
  });

  it.each(["/", "/catalog", "/catalog/20260101_120000", "/admin", "/admin/users/u1", "/auth/signin", "/unknown"])(
    "shows the logo on %s",
    (pathname) => {
      const result = buildCatalogRouteState(pathname, LABELS);

      expect(result.backTargetUrl).toBeNull();
    }
  );

  it("never offers a way back from the catalog list, even with an origin", () => {
    const result = buildCatalogRouteState("/catalog/20260101_120000", LABELS, {
      backToPath: "/downloads",
    });

    expect(result.backTargetUrl).toBeNull();
  });

  it.each([
    ["/downloads", "/catalog"],
    ["/settings", "/catalog"],
    ["/bookmarks", "/catalog"],
    ["/catalog/c1/settings", "/catalog/c1"],
    ["/catalog/c1/deep-search", "/catalog/c1"],
    ["/catalog/c1/deep-search/job-1", "/catalog/c1/deep-search"],
    ["/catalog/c1/events/unassigned", "/catalog/c1?tab=events"],
    ["/catalog/c1/event/7/artwork", "/catalog/c1/event/7"],
    ["/catalog/c1/recording/hash123/correction", "/catalog/c1/recording/hash123"],
  ])("leads back from %s to its parent %s", (pathname, parent) => {
    const result = buildCatalogRouteState(pathname, LABELS);

    expect(result.backTargetUrl).toBe(parent);
  });

  it.each(["/settings", "/bookmarks", "/catalog/c1/settings"])(
    "returns from %s to the page it was opened from",
    (pathname) => {
      const result = buildCatalogRouteState(pathname, LABELS, {
        backToPath: "/catalog/c1/event/7",
      });

      expect(result.backTargetUrl).toBe("/catalog/c1/event/7");
    }
  );

  it("returns from Downloads to the page it was opened from", () => {
    const result = buildCatalogRouteState("/downloads", LABELS, {
      backToPath: "/catalog/c1/recording/hash123?seek=12",
    });

    expect(result.backTargetUrl).toBe("/catalog/c1/recording/hash123?seek=12");
    expect(result.backTargetLabel).toBe("Back");
  });

  it("returns from an event opened in Downloads to Downloads", () => {
    const result = buildCatalogRouteState("/catalog/c1/event/7", LABELS, {
      backToPath: "/downloads",
    });

    expect(result.backTargetUrl).toBe("/downloads");
  });

  it("treats Downloads as home when it is the home page and has no origin", () => {
    const home = buildCatalogRouteState("/downloads", LABELS, { downloadsIsHome: true });
    const opened = buildCatalogRouteState("/downloads", LABELS, {
      downloadsIsHome: true,
      backToPath: "/catalog/c1/event/7",
    });

    expect(home.backTargetUrl).toBeNull();
    expect(opened.backTargetUrl).toBe("/catalog/c1/event/7");
  });

  it("ignores an origin the offline shell cannot open while offline", () => {
    const settings = buildCatalogRouteState("/downloads", LABELS, {
      backToPath: "/settings",
      downloadsIsHome: true,
      offline: true,
    });
    const event = buildCatalogRouteState("/downloads", LABELS, {
      backToPath: "/catalog/c1/event/7",
      downloadsIsHome: true,
      offline: true,
    });
    const editor = buildCatalogRouteState("/catalog/c1/recording/hash123", LABELS, {
      backToPath: "/catalog/c1/event/7/edit",
      offline: true,
    });

    expect(settings.backTargetUrl).toBeNull();
    expect(event.backTargetUrl).toBe("/catalog/c1/event/7");
    expect(editor.backTargetUrl).toBe("/catalog/c1");
  });

  it.each([
    "https://evil.example/x",
    "//evil.example/x",
    "/api/catalogs",
    "/auth/signin",
    "/downloads",
    "/downloads?warm=1",
  ])(
    "ignores the unusable origin %s",
    (backToPath) => {
      const result = buildCatalogRouteState("/downloads", LABELS, { backToPath });

      expect(result.backTargetUrl).toBe("/catalog");
      expect(result.backTargetLabel).toBe("Back to catalog");
    }
  );

  it("treats invalid route group ids as null when a valid id list is provided", () => {
    const result = resolveEffectiveCatalogId({
      routeGroupId: "missing-group",
      activeGroupId: "preferred-group",
      validGroupIds: ["preferred-group", "other-group"],
    });

    expect(result.routeGroupInvalid).toBe(true);
    expect(result.effectiveCatalogId).toBeNull();
  });

  it("prefers the route group id when no validation list is provided", () => {
    const result = resolveEffectiveCatalogId({
      routeGroupId: "route-group",
      activeGroupId: "preferred-group",
    });

    expect(result.routeGroupInvalid).toBe(false);
    expect(result.effectiveCatalogId).toBe("route-group");
  });
});
