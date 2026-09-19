import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  default: {
    catalogEvent: {
      groupBy: vi.fn(),
    },
  },
}));

describe("countSessionsByDate", () => {
  let prisma: { catalogEvent: { groupBy: ReturnType<typeof vi.fn> } };
  let countSessionsByDate: typeof import("@/lib/catalog-events/read-service").countSessionsByDate;
  let sessionDateKey: typeof import("@/lib/catalog-events/read-service").sessionDateKey;

  const catalogId = "20260201_120000";

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    const mod = await import("@/lib/catalog-events/read-service");
    countSessionsByDate = mod.countSessionsByDate;
    sessionDateKey = mod.sessionDateKey;
  });

  it("returns a count per location and date", async () => {
    prisma.catalogEvent.groupBy.mockResolvedValue([
      { locationId: 7, dateYear: 2026, dateMonth: 7, dateDay: 4, _count: { _all: 2 } },
      { locationId: 9, dateYear: 2026, dateMonth: 7, dateDay: 19, _count: { _all: 1 } },
    ]);

    const counts = await countSessionsByDate(catalogId, null, {}, [
      { locationId: 7, dateYear: 2026, dateMonth: 7, dateDay: 4 },
      { locationId: 9, dateYear: 2026, dateMonth: 7, dateDay: 19 },
    ]);

    expect(
      counts.get(sessionDateKey({ locationId: 7, dateYear: 2026, dateMonth: 7, dateDay: 4 }))
    ).toBe(2);
    expect(
      counts.get(sessionDateKey({ locationId: 9, dateYear: 2026, dateMonth: 7, dateDay: 19 }))
    ).toBe(1);
  });

  it("asks for each location and date once even when a page repeats it", async () => {
    prisma.catalogEvent.groupBy.mockResolvedValue([]);

    // Both sessions of one day arrive on the same page and must not be
    // queried twice.
    await countSessionsByDate(catalogId, null, {}, [
      { locationId: 7, dateYear: 2026, dateMonth: 7, dateDay: 4 },
      { locationId: 7, dateYear: 2026, dateMonth: 7, dateDay: 4 },
    ]);

    const call = prisma.catalogEvent.groupBy.mock.calls[0][0];
    expect(call.where.AND[1].OR).toEqual([
      { locationId: 7, dateYear: 2026, dateMonth: 7, dateDay: 4 },
    ]);
  });

  it("carries the caller's visibility and filters into the count", async () => {
    prisma.catalogEvent.groupBy.mockResolvedValue([]);

    await countSessionsByDate(catalogId, [11, 12], { released: true }, [
      { locationId: 7, dateYear: 2026, dateMonth: null, dateDay: null },
    ]);

    // A cue promising a second event the reader cannot open would be a lie,
    // so the count must be scoped exactly like the listing.
    const call = prisma.catalogEvent.groupBy.mock.calls[0][0];
    expect(call.where.AND[0]).toMatchObject({
      workflowGroupId: catalogId,
      released: true,
      id: { in: [11, 12] },
    });
  });

  it("skips the query entirely for an empty page", async () => {
    const counts = await countSessionsByDate(catalogId, null, {}, []);

    expect(counts.size).toBe(0);
    expect(prisma.catalogEvent.groupBy).not.toHaveBeenCalled();
  });

  it("keeps a partial date distinct from a full one at the same place", async () => {
    // (2026, 7, null) and (2026, 7, 4) are separate identity slots, exactly as
    // the unique index treats them.
    const partial = sessionDateKey({
      locationId: 7,
      dateYear: 2026,
      dateMonth: 7,
      dateDay: null,
    });
    const full = sessionDateKey({
      locationId: 7,
      dateYear: 2026,
      dateMonth: 7,
      dateDay: 4,
    });

    expect(partial).not.toBe(full);
  });
});
