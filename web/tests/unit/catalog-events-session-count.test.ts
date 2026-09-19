import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  default: {
    catalogEvent: {
      findMany: vi.fn(),
    },
  },
}));

describe("loadSessionOrdinals", () => {
  let prisma: { catalogEvent: { findMany: ReturnType<typeof vi.fn> } };
  let loadSessionOrdinals: typeof import("@/lib/catalog-events/read-service").loadSessionOrdinals;
  let sessionDateKey: typeof import("@/lib/catalog-events/read-service").sessionDateKey;

  const catalogId = "20260201_120000";

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    const mod = await import("@/lib/catalog-events/read-service");
    loadSessionOrdinals = mod.loadSessionOrdinals;
    sessionDateKey = mod.sessionDateKey;
  });

  it("derives dense ordinals even when stored session indexes have gaps", async () => {
    prisma.catalogEvent.findMany.mockResolvedValue([
      {
        id: 90,
        locationId: 7,
        dateYear: 2026,
        dateMonth: 7,
        dateDay: 4,
        sessionIndex: 3,
      },
      {
        id: 88,
        locationId: 7,
        dateYear: 2026,
        dateMonth: 7,
        dateDay: 4,
        sessionIndex: 1,
      },
      {
        id: 91,
        locationId: 9,
        dateYear: 2026,
        dateMonth: 7,
        dateDay: 19,
        sessionIndex: 4,
      },
    ]);

    const ordinals = await loadSessionOrdinals(catalogId, null, [
      { locationId: 7, dateYear: 2026, dateMonth: 7, dateDay: 4 },
      { locationId: 9, dateYear: 2026, dateMonth: 7, dateDay: 19 },
    ]);

    expect(ordinals.get(88)).toEqual({ ordinal: 1, count: 2 });
    expect(ordinals.get(90)).toEqual({ ordinal: 2, count: 2 });
    expect(ordinals.get(91)).toEqual({ ordinal: 1, count: 1 });
  });

  it("asks for each location and date once even when a page repeats it", async () => {
    prisma.catalogEvent.findMany.mockResolvedValue([]);

    await loadSessionOrdinals(catalogId, null, [
      { locationId: 7, dateYear: 2026, dateMonth: 7, dateDay: 4 },
      { locationId: 7, dateYear: 2026, dateMonth: 7, dateDay: 4 },
    ]);

    const call = prisma.catalogEvent.findMany.mock.calls[0][0];
    expect(call.where.AND[1].OR).toEqual([
      { locationId: 7, dateYear: 2026, dateMonth: 7, dateDay: 4 },
    ]);
  });

  it("scopes siblings to visibility without applying page filters", async () => {
    prisma.catalogEvent.findMany.mockResolvedValue([]);

    await loadSessionOrdinals(catalogId, [11, 12], [
      { locationId: 7, dateYear: 2026, dateMonth: null, dateDay: null },
    ]);

    const call = prisma.catalogEvent.findMany.mock.calls[0][0];
    expect(call.where.AND[0]).toEqual({
      workflowGroupId: catalogId,
      id: { in: [11, 12] },
    });
  });

  it("skips the query entirely for an empty page", async () => {
    const ordinals = await loadSessionOrdinals(catalogId, null, []);

    expect(ordinals.size).toBe(0);
    expect(prisma.catalogEvent.findMany).not.toHaveBeenCalled();
  });

  it("keeps a partial date distinct from a full one at the same place", () => {
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
