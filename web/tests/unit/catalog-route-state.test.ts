import { describe, expect, it } from "vitest";
import { buildCatalogRouteState } from "@/hooks/use-catalog-route-state";
import { resolveEffectiveCatalogId } from "@/hooks/use-effective-catalog-id";

const LABELS = {
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
    expect(result.isRecordingRoute).toBe(true);
    expect(result.isRecordingSubpage).toBe(true);
    expect(result.recordingHash).toBe("hash123");
    expect(result.backTargetUrl).toBe("/catalog/20260101_120000/recording/hash123");
    expect(result.backTargetLabel).toBe("Back to recording");
  });

  it("builds event detail navigation state", () => {
    const result = buildCatalogRouteState(
      "/catalog/20260101_120000/event/event-1",
      LABELS
    );

    expect(result.routeGroupId).toBe("20260101_120000");
    expect(result.isEventRoute).toBe(true);
    expect(result.isDetailRoute).toBe(true);
    expect(result.eventId).toBe("event-1");
    expect(result.backTargetUrl).toBe("/catalog/20260101_120000?tab=events");
    expect(result.backTargetLabel).toBe("Back to catalog");
  });

  it("uses an explicit back target for recording detail routes", () => {
    const result = buildCatalogRouteState(
      "/catalog/20260101_120000/recording/hash123",
      LABELS,
      { backToPath: "/catalog/20260101_120000/events/unassigned" }
    );

    expect(result.isRecordingRoute).toBe(true);
    expect(result.isRecordingSubpage).toBe(false);
    expect(result.backTargetUrl).toBe("/catalog/20260101_120000/events/unassigned");
    expect(result.backTargetLabel).toBe("Back to catalog");
  });

  it("falls back to catalog index for non-detail pages", () => {
    const result = buildCatalogRouteState("/catalog/20260101_120000", LABELS);

    expect(result.isDetailRoute).toBe(false);
    expect(result.backTargetUrl).toBe("/catalog/20260101_120000");
    expect(result.backTargetLabel).toBe("Back to catalog");
  });

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
