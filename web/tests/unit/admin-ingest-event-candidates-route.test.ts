import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/ingest/event-candidates/route";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getAdminCapability: vi.fn(),
  loadEventCreationContext: vi.fn(),
}));

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: mocks.requireAuth,
  AuthError: class AuthError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 403) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));
vi.mock("@/lib/access/capabilities", () => ({ getAdminCapability: mocks.getAdminCapability }));
vi.mock("@/lib/archive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/archive")>()),
  requireArchive: vi.fn(async () => ({ id: "20260201_120000", label: "Main" })),
}));
vi.mock("@/lib/catalog-events/create-candidates", () => ({
  loadEventCreationContext: mocks.loadEventCreationContext,
}));
vi.mock("@/lib/db", () => ({
  default: { $transaction: vi.fn(async (callback: (tx: object) => unknown) => callback({})) },
}));

function get(query: string) {
  return GET(new NextRequest(`http://localhost/api/admin/ingest/event-candidates?${query}`));
}

describe("admin ingest event candidates route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue("admin-1");
    mocks.getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
  });

  it("returns the events that cover the place and date", async () => {
    const candidates = [
      { id: 9, title: "Praha 17. 11. 2026", sessionIndex: 1, recordingCount: 1, primaryTitle: null },
    ];
    mocks.loadEventCreationContext.mockResolvedValue({ candidates, nextSessionIndex: 2 });

    const response = await get("locationId=7&dateYear=2026&dateMonth=11&dateDay=17");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ candidates });
    expect(mocks.loadEventCreationContext).toHaveBeenCalledWith(
      {},
      {
        workflowGroupId: "20260201_120000",
        locationId: 7,
        dateYear: 2026,
        dateMonth: 11,
        dateDay: 17,
      }
    );
  });

  it("is admin only and validates the query", async () => {
    expect((await get("locationId=x&dateYear=2026")).status).toBe(400);
    mocks.getAdminCapability.mockResolvedValue({ canAccessAdmin: false });
    expect((await get("locationId=7&dateYear=2026")).status).toBe(403);
    expect(mocks.loadEventCreationContext).not.toHaveBeenCalled();
  });
});
