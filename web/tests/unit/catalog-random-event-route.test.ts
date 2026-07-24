import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getRandomEvent } from "@/app/api/catalogs/[id]/random-event/route";
import { deriveEventTitle } from "@/lib/catalog-events/utils";

vi.mock("@/lib/auth/permissions", () => ({
  getCurrentUserId: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/catalog-events/visibility", () => ({
  getPublishedVisibleEventIds: vi.fn(),
}));

vi.mock("@/lib/features/capabilities", () => ({
  getLabsPreferenceForUser: vi.fn(),
  isFeatureEnabledForUser: vi.fn(),
}));

vi.mock("@/lib/catalog", async () => {
  const actual = await vi.importActual<typeof import("@/lib/catalog")>(
    "@/lib/catalog"
  );
  return {
    ...actual,
    getCatalogEntriesByHashes: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  default: {
    catalogEvent: {
      findMany: vi.fn(),
    },
  },
}));

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// One row in the shape the route selects from prisma.catalogEvent.findMany.
function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: "Spring Gathering",
    dateYear: 2024,
    dateMonth: 3,
    dateDay: 15,
    location: { name: "Location X" },
    recordings: [{ audioHash: HASH_A }],
    ...overrides,
  };
}

// One row in the shape getCatalogEntriesByHashes returns (domain CatalogEntry).
function entryRow(hash: string, overrides: Record<string, unknown> = {}) {
  return {
    hash,
    isActionable: true,
    isPublished: true,
    title: "recording title",
    filename: "recording.mp3",
    duration: "00:01:00",
    ...overrides,
  };
}

describe("catalog random event route", () => {
  const catalogId = "20260201_120000";

  let getCurrentUserId: ReturnType<typeof vi.fn>;
  let getCatalogCapability: ReturnType<typeof vi.fn>;
  let getPublishedVisibleEventIds: ReturnType<typeof vi.fn>;
  let getLabsPreferenceForUser: ReturnType<typeof vi.fn>;
  let isFeatureEnabledForUser: ReturnType<typeof vi.fn>;
  let getCatalogEntriesByHashes: ReturnType<typeof vi.fn>;
  let prisma: {
    catalogEvent: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    getCurrentUserId = (await import("@/lib/auth/permissions")).getCurrentUserId as ReturnType<
      typeof vi.fn
    >;
    getCatalogCapability = (
      await import("@/lib/access/capabilities")
    ).getCatalogCapability as ReturnType<typeof vi.fn>;
    getPublishedVisibleEventIds = (
      await import("@/lib/catalog-events/visibility")
    ).getPublishedVisibleEventIds as ReturnType<typeof vi.fn>;
    getCatalogEntriesByHashes = (await import("@/lib/catalog")).getCatalogEntriesByHashes as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    const features = await import("@/lib/features/capabilities");
    getLabsPreferenceForUser = features.getLabsPreferenceForUser as ReturnType<typeof vi.fn>;
    isFeatureEnabledForUser = features.isFeatureEnabledForUser as ReturnType<typeof vi.fn>;
    getLabsPreferenceForUser.mockResolvedValue({ enabled: false });
    isFeatureEnabledForUser.mockReturnValue(true);
  });

  function callRoute() {
    return getRandomEvent(
      new NextRequest(`http://localhost/api/catalogs/${catalogId}/random-event`),
      { params: Promise.resolve({ id: catalogId }) }
    );
  }

  it("returns 404 when the catalog does not exist", async () => {
    getCurrentUserId.mockResolvedValue("viewer-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: false,
      hasAccess: false,
    });

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(getPublishedVisibleEventIds).not.toHaveBeenCalled();
    expect(getCatalogEntriesByHashes).not.toHaveBeenCalled();
  });

  it("returns 404 when the user has access but the catalog is missing", async () => {
    getCurrentUserId.mockResolvedValue("owner-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: false,
      hasAccess: true,
      accessLevel: "OWNER",
    });

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(getPublishedVisibleEventIds).not.toHaveBeenCalled();
    expect(getCatalogEntriesByHashes).not.toHaveBeenCalled();
  });

  it("returns no track when the catalog has no released events", async () => {
    getCurrentUserId.mockResolvedValue("listener-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      accessLevel: "LISTENER",
    });
    getPublishedVisibleEventIds.mockResolvedValue([]);

    const response = await callRoute();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hash).toBeNull();
    expect(body.total).toBe(0);
    // No released events -> skip the catalog load and event lookup entirely.
    expect(getCatalogEntriesByHashes).not.toHaveBeenCalled();
    expect(prisma.catalogEvent.findMany).not.toHaveBeenCalled();
  });

  it("plays an event primary and serves the event's metadata", async () => {
    getCurrentUserId.mockResolvedValue("listener-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      accessLevel: "LISTENER",
    });
    getPublishedVisibleEventIds.mockResolvedValue([1]);
    prisma.catalogEvent.findMany.mockResolvedValue([eventRow()]);
    // The route fetches only the event-primary hashes, so the catalog lookup
    // returns just the primary.
    getCatalogEntriesByHashes.mockResolvedValue([entryRow(HASH_A)]);

    const response = await callRoute();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hash).toBe(HASH_A);
    expect(body.total).toBe(1);
    // Banner metadata comes from the event, not the recording.
    expect(body.eventId).toBe(1);
    expect(body.title).toBe("Spring Gathering");
    expect(body.dateYear).toBe(2024);
    expect(body.dateMonth).toBe(3);
    expect(body.dateDay).toBe(15);
    expect(body.locationName).toBe("Location X");
    // Duration still comes from the recording's catalog entry.
    expect(body.duration).toBe("00:01:00");
  });

  it("restricts the pool to event primaries for owners too", async () => {
    getCurrentUserId.mockResolvedValue("owner-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      accessLevel: "OWNER",
    });
    getPublishedVisibleEventIds.mockResolvedValue([1]);
    prisma.catalogEvent.findMany.mockResolvedValue([eventRow()]);
    getCatalogEntriesByHashes.mockResolvedValue([entryRow(HASH_A)]);

    const response = await callRoute();

    expect(response.status).toBe(200);
    const body = await response.json();
    // The released-event pool applies to owners too (not just listeners), and
    // the route fetches exactly the event-primary hashes.
    expect(body.hash).toBe(HASH_A);
    expect(body.total).toBe(1);
    expect(getCatalogEntriesByHashes).toHaveBeenCalledWith(catalogId, [HASH_A]);
  });

  it("drops a non-actionable primary even for non-listener roles", async () => {
    // Access scoping is a no-op for OWNER, so the route's own isActionable
    // guard is what keeps a non-actionable primary out of the pool.
    getCurrentUserId.mockResolvedValue("owner-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      accessLevel: "OWNER",
    });
    getPublishedVisibleEventIds.mockResolvedValue([1]);
    prisma.catalogEvent.findMany.mockResolvedValue([eventRow()]);
    getCatalogEntriesByHashes.mockResolvedValue([
      entryRow(HASH_A, { isActionable: false }),
    ]);

    const response = await callRoute();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hash).toBeNull();
    expect(body.total).toBe(0);
  });

  it("derives the title from location and date when the event has no title", async () => {
    getCurrentUserId.mockResolvedValue("listener-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      accessLevel: "LISTENER",
    });
    getPublishedVisibleEventIds.mockResolvedValue([1]);
    prisma.catalogEvent.findMany.mockResolvedValue([eventRow({ title: null })]);
    getCatalogEntriesByHashes.mockResolvedValue([entryRow(HASH_A)]);

    const response = await callRoute();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.title).toBe(deriveEventTitle("Location X", 2024, 3, 15));
  });

  it("passes through a partial event date", async () => {
    getCurrentUserId.mockResolvedValue("listener-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      accessLevel: "LISTENER",
    });
    getPublishedVisibleEventIds.mockResolvedValue([1]);
    // Year-only event date (no month/day).
    prisma.catalogEvent.findMany.mockResolvedValue([
      eventRow({ dateMonth: null, dateDay: null }),
    ]);
    getCatalogEntriesByHashes.mockResolvedValue([entryRow(HASH_A)]);

    const response = await callRoute();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dateYear).toBe(2024);
    expect(body.dateMonth).toBeNull();
    expect(body.dateDay).toBeNull();
  });

  it("returns no track when released-event primaries are filtered out by the catalog", async () => {
    getCurrentUserId.mockResolvedValue("listener-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      accessLevel: "LISTENER",
    });
    getPublishedVisibleEventIds.mockResolvedValue([1]);
    prisma.catalogEvent.findMany.mockResolvedValue([eventRow()]);
    // The event primary exists, but its catalog entry is no longer actionable,
    // so it is dropped and the pool ends up empty (the second empty-pool guard,
    // distinct from the "no released events" early return).
    getCatalogEntriesByHashes.mockResolvedValue([entryRow(HASH_A, { isActionable: false })]);

    const response = await callRoute();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hash).toBeNull();
    expect(body.total).toBe(0);
    // Reached the second guard: the catalog was loaded but nothing survived.
    expect(getCatalogEntriesByHashes).toHaveBeenCalled();
  });

  it("drops a primary the listener cannot see even if the visibility lookup returns it", async () => {
    getCurrentUserId.mockResolvedValue("listener-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      accessLevel: "LISTENER",
    });
    getPublishedVisibleEventIds.mockResolvedValue([1, 2]);
    prisma.catalogEvent.findMany.mockResolvedValue([
      eventRow({ id: 1, recordings: [{ audioHash: HASH_A }] }),
      eventRow({
        id: 2,
        title: "City Interview",
        location: { name: "Location Y" },
        recordings: [{ audioHash: HASH_B }],
      }),
    ]);
    getCatalogEntriesByHashes.mockResolvedValue([
      // This case is handled by access scoping, not the event-primary filter:
      // getPublishedVisibleEventIds should never surface an event whose primary
      // is unpublished, but if it did, scopeCatalogEntriesForAccess still hides
      // the unpublished primary from a listener (defense in depth).
      entryRow(HASH_A, { isPublished: false }),
      entryRow(HASH_B),
    ]);

    const response = await callRoute();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hash).toBe(HASH_B);
    expect(body.eventId).toBe(2);
    expect(body.total).toBe(1);
  });

  it("returns no track when the events feature is disabled for the user", async () => {
    getCurrentUserId.mockResolvedValue("listener-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      accessLevel: "LISTENER",
    });
    isFeatureEnabledForUser.mockReturnValue(false);

    const response = await callRoute();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hash).toBeNull();
    // Gated before any event/catalog lookup, mirroring the event page's gate.
    expect(getPublishedVisibleEventIds).not.toHaveBeenCalled();
    expect(getCatalogEntriesByHashes).not.toHaveBeenCalled();
  });

  it("excludes recently played primaries and resets when all are excluded", async () => {
    getCurrentUserId.mockResolvedValue("listener-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      accessLevel: "LISTENER",
    });
    getPublishedVisibleEventIds.mockResolvedValue([1, 2]);
    prisma.catalogEvent.findMany.mockResolvedValue([
      eventRow({ id: 1, recordings: [{ audioHash: HASH_A }] }),
      eventRow({
        id: 2,
        title: "City Interview",
        location: { name: "Location Y" },
        recordings: [{ audioHash: HASH_B }],
      }),
    ]);
    getCatalogEntriesByHashes.mockResolvedValue([entryRow(HASH_A), entryRow(HASH_B)]);

    // Excluding A leaves B as the only candidate; no reset.
    const excludeA = await getRandomEvent(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/random-event?exclude=${HASH_A}`
      ),
      { params: Promise.resolve({ id: catalogId }) }
    );
    const excludeABody = await excludeA.json();
    expect(excludeABody.hash).toBe(HASH_B);
    expect(excludeABody.historyReset).toBe(false);
    expect(excludeABody.total).toBe(2);

    // Excluding both empties the pool, so history resets and a track returns.
    const excludeBoth = await getRandomEvent(
      new NextRequest(
        `http://localhost/api/catalogs/${catalogId}/random-event?exclude=${HASH_A},${HASH_B}`
      ),
      { params: Promise.resolve({ id: catalogId }) }
    );
    const excludeBothBody = await excludeBoth.json();
    expect([HASH_A, HASH_B]).toContain(excludeBothBody.hash);
    expect(excludeBothBody.historyReset).toBe(true);
  });
});
