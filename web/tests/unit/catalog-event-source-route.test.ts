import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getEventSource } from "@/app/api/catalogs/[id]/events/[eventId]/sources/[sourceId]/route";

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/access/catalog-management-route-access", () => ({
  requireCatalogManagementAccess: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
}));

vi.mock("@/lib/event-sources", () => ({
  readEventSources: vi.fn(),
  resolveEventSourcesDir: vi.fn(),
  writeEventSources: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    catalogEvent: {
      findFirst: vi.fn(),
    },
  },
}));

describe("catalog event source route", () => {
  const catalogId = "20260201_120000";
  const eventId = 12;
  const sourceId = "source-1";

  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let requireCatalogManagementAccess: ReturnType<typeof vi.fn>;
  let readEventSources: ReturnType<typeof vi.fn>;
  let prisma: {
    catalogEvent: { findFirst: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    requireCatalogEventsAccess = (
      await import("@/lib/catalog-events/access")
    ).requireCatalogEventsAccess as ReturnType<typeof vi.fn>;
    requireCatalogManagementAccess = (
      await import("@/lib/access/catalog-management-route-access")
    ).requireCatalogManagementAccess as ReturnType<typeof vi.fn>;
    readEventSources = (await import("@/lib/event-sources")).readEventSources as ReturnType<
      typeof vi.fn
    >;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireCatalogEventsAccess.mockResolvedValue({
      userId: "viewer-1",
      accessLevel: "VIEWER",
    });
    requireCatalogManagementAccess.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Access denied to sources" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    });
  });

  it("returns 403 when the user cannot manage an event source", async () => {
    const response = await getEventSource(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/events/${eventId}/sources/${sourceId}`
      ),
      {
        params: Promise.resolve({
          id: catalogId,
          eventId: String(eventId),
          sourceId,
        }),
      }
    );

    expect(response.status).toBe(403);
    expect(requireCatalogManagementAccess).toHaveBeenCalledWith(catalogId, {
      userId: "viewer-1",
      auditResource: "event_sources",
      auditResourceId: String(eventId),
      deniedMessage: "Access denied to sources",
      deniedReason: "Not owner/admin",
    });
    expect(prisma.catalogEvent.findFirst).not.toHaveBeenCalled();
    expect(readEventSources).not.toHaveBeenCalled();
  });
});
