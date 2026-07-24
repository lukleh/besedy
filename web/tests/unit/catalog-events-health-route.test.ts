import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/catalogs/[id]/events/health/route";

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/catalog-events/health", () => ({
  getEventCatalogHealth: vi.fn(),
}));

describe("catalog events health route", () => {
  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let getEventCatalogHealth: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    requireCatalogEventsAccess = (
      await import("@/lib/catalog-events/access")
    ).requireCatalogEventsAccess as ReturnType<typeof vi.fn>;
    getEventCatalogHealth = (
      await import("@/lib/catalog-events/health")
    ).getEventCatalogHealth as ReturnType<typeof vi.fn>;

    requireCatalogEventsAccess.mockResolvedValue({
      userId: "owner-1",
      accessLevel: "OWNER",
      policyContext: {
        featureEnabled: true,
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: "OWNER",
        isCatalogAdmin: false,
      },
    });
    getEventCatalogHealth.mockResolvedValue({
      totalEvents: 3,
      releasedEvents: 1,
      unreleasedEvents: 2,
      missingPrimaryRecording: 0,
      missingPosterImage: 0,
    });
  });

  it("passes includeInactive through to the event access helper", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/catalogs/20260201_120000/events/health?includeInactive=true"
      ),
      {
        params: Promise.resolve({ id: "20260201_120000" }),
      }
    );

    expect(response.status).toBe(200);
    expect(requireCatalogEventsAccess).toHaveBeenCalledWith(
      "20260201_120000",
      "edit",
      { activeCatalogOnly: false }
    );
  });
});
