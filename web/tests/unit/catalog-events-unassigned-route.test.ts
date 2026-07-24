import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getUnassignedRecordings } from "@/app/api/catalog-events/unassigned/route";

vi.mock("@/lib/catalog-events/access", () => ({
  requireCatalogEventsAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    $queryRaw: vi.fn(),
    workflowGroup: {
      findFirst: vi.fn(),
    },
  },
}));

function sqlText(query: unknown): string {
  const strings = (query as { strings?: ReadonlyArray<string> }).strings;
  return strings ? strings.join(" ? ") : String(query);
}

describe("catalog events unassigned route", () => {
  const catalogId = "20260201_120000";

  let requireCatalogEventsAccess: ReturnType<typeof vi.fn>;
  let mockedPrisma: {
    $queryRaw: ReturnType<typeof vi.fn>;
    workflowGroup: {
      findFirst: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    requireCatalogEventsAccess = (
      await import("@/lib/catalog-events/access")
    ).requireCatalogEventsAccess as ReturnType<typeof vi.fn>;
    mockedPrisma = (await import("@/lib/db")).default as unknown as typeof mockedPrisma;

    requireCatalogEventsAccess.mockResolvedValue({
      userId: "admin-user",
      accessLevel: "OWNER",
    });
    mockedPrisma.workflowGroup.findFirst.mockResolvedValue({ id: catalogId });
  });

  it("pushes recordings without dates to the end of the default date sort", async () => {
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([{ total: 2 }])
      .mockResolvedValueOnce([
        {
          audioHash: "a".repeat(64),
          dateYear: 2025,
          dateMonth: null,
          dateDay: null,
          locationId: null,
          locationName: null,
          recorderName: "Zdenda",
        },
      ]);

    const response = await getUnassignedRecordings(
      new NextRequest(
        `http://localhost/api/catalog-events/unassigned?group=${catalogId}&page=1&limit=50`
      )
    );

    expect(response.status).toBe(200);
    expect(mockedPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    const [, listQuery] = mockedPrisma.$queryRaw.mock.calls;
    expect(sqlText(listQuery[0])).toContain("NULLS LAST");

    const body = await response.json();
    expect(body.entries).toEqual([
      {
        audioHash: "a".repeat(64),
        dateYear: 2025,
        dateMonth: null,
        dateDay: null,
        locationId: null,
        locationName: null,
        recorderName: "Zdenda",
      },
    ]);
  });
});
