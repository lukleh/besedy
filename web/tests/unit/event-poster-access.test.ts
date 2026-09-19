import { beforeEach, describe, expect, it, vi } from "vitest";
import { grantFromLevel } from "@/lib/policy/catalog-permissions";

const { isPublishedVisibleEvent, logAccessDenied, requireCatalogEventsAccess } = vi.hoisted(() => ({
  isPublishedVisibleEvent: vi.fn(),
  logAccessDenied: vi.fn(),
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/catalog-events/access", () => ({ requireCatalogEventsAccess }));
vi.mock("@/lib/catalog-events/visibility", () => ({ isPublishedVisibleEvent }));
vi.mock("@/lib/audit/logger", () => ({ logAccessDenied }));
vi.mock("@/lib/db", () => ({ default: {} }));

import { requireEventPosterAccess } from "@/lib/event-poster-access";

describe("event poster access", () => {
  const catalogId = "20260919_120000";
  const eventId = 7;

  beforeEach(() => {
    vi.clearAllMocks();
    isPublishedVisibleEvent.mockResolvedValue(true);
  });

  it("does not let an additive poster permission reveal an unreleased event", async () => {
    const catalogGrant = {
      ...grantFromLevel("LISTENER"),
      extras: ["manage_event_posters" as const],
    };
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "listener-1",
      catalogGrant,
      policyContext: {
        featureEnabled: true,
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant,
        isCatalogAdmin: false,
      },
    });
    isPublishedVisibleEvent.mockResolvedValue(false);

    await expect(requireEventPosterAccess(catalogId, eventId, "manage")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(logAccessDenied).toHaveBeenCalledWith(
      "listener-1",
      "event_poster",
      String(eventId),
      expect.objectContaining({
        reason: "Event is outside the actor's visibility scope",
      })
    );
  });

  it("allows the same capability for a listener-visible event", async () => {
    const catalogGrant = {
      ...grantFromLevel("LISTENER"),
      extras: ["manage_event_posters" as const],
    };
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "listener-1",
      catalogGrant,
      policyContext: {
        featureEnabled: true,
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant,
        isCatalogAdmin: false,
      },
    });

    await expect(requireEventPosterAccess(catalogId, eventId, "manage")).resolves.toEqual({
      userId: "listener-1",
    });
    expect(isPublishedVisibleEvent).toHaveBeenCalledWith({}, catalogId, eventId);
  });

  it("does not query listener visibility for an actor who can see unreleased events", async () => {
    const catalogGrant = grantFromLevel("OWNER");
    requireCatalogEventsAccess.mockResolvedValue({
      userId: "owner-1",
      catalogGrant,
      policyContext: {
        featureEnabled: true,
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant,
        isCatalogAdmin: false,
      },
    });

    await expect(requireEventPosterAccess(catalogId, eventId, "publish")).resolves.toEqual({
      userId: "owner-1",
    });
    expect(isPublishedVisibleEvent).not.toHaveBeenCalled();
  });
});
