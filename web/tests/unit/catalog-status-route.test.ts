import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getCatalogStatus } from "@/app/api/catalogs/[id]/status/route";

vi.mock("@/lib/auth/permissions", () => ({
  getCurrentUserId: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    workflowGroup: {
      findFirst: vi.fn(),
    },
  },
}));

describe("catalog status route", () => {
  const catalogId = "20260201_120000";

  let getCurrentUserId: ReturnType<typeof vi.fn>;
  let getCatalogCapability: ReturnType<typeof vi.fn>;
  let prisma: {
    workflowGroup: { findFirst: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    getCurrentUserId = (await import("@/lib/auth/permissions")).getCurrentUserId as ReturnType<
      typeof vi.fn
    >;
    getCatalogCapability = (
      await import("@/lib/access/capabilities")
    ).getCatalogCapability as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  it("returns 404 when the catalog does not exist", async () => {
    getCurrentUserId.mockResolvedValue("viewer-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: false,
      hasAccess: false,
    });

    const response = await getCatalogStatus(new NextRequest("http://localhost"), {
      params: Promise.resolve({ id: catalogId }),
    });

    expect(response.status).toBe(404);
    expect(prisma.workflowGroup.findFirst).not.toHaveBeenCalled();
  });

  it("returns 404 when the user has access but the catalog is missing", async () => {
    getCurrentUserId.mockResolvedValue("owner-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: false,
      hasAccess: true,
    });

    const response = await getCatalogStatus(new NextRequest("http://localhost"), {
      params: Promise.resolve({ id: catalogId }),
    });

    expect(response.status).toBe(404);
    expect(prisma.workflowGroup.findFirst).not.toHaveBeenCalled();
  });

  it("returns the catalog status for an authorized user", async () => {
    const updatedAt = new Date("2026-03-10T10:00:00.000Z");

    getCurrentUserId.mockResolvedValue("owner-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
    });
    prisma.workflowGroup.findFirst.mockResolvedValue({
      id: catalogId,
      updatedAt,
      _count: { metadata: 42 },
    });

    const response = await getCatalogStatus(new NextRequest("http://localhost"), {
      params: Promise.resolve({ id: catalogId }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      catalogId,
      lastModifiedAt: updatedAt.toISOString(),
      curatedEntries: 42,
    });
  });
});
