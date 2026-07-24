import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PATCH as patchReady } from "@/app/api/catalogs/[id]/recordings/[hash]/ready/route";

const CATALOG_ID = "20251225_120000";
const HASH = "a".repeat(64);

vi.mock("@/lib/access/catalog-management-route-access", () => ({
  requireCatalogManagementAccess: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  AuditAction: {
    CATALOG_UPDATED: "CATALOG_UPDATED",
  },
  logAccessDenied: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    catalogEntry: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    catalogEventRecording: {
      findUnique: vi.fn(),
    },
    workflowGroup: {
      update: vi.fn(),
    },
  },
}));

describe("recording ready route", () => {
  let requireCatalogManagementAccess: ReturnType<typeof vi.fn>;
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
    catalogEntry: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    catalogEventRecording: {
      findUnique: ReturnType<typeof vi.fn>;
    };
    workflowGroup: {
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const accessModule = await import("@/lib/access/catalog-management-route-access");
    requireCatalogManagementAccess =
      accessModule.requireCatalogManagementAccess as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)
    );
    prisma.$queryRaw.mockResolvedValue([{ audioHash: HASH }]);
  });

  it("returns 403 when the user cannot manage access", async () => {
    requireCatalogManagementAccess.mockResolvedValue({
      ok: false,
      response: new Response(
        JSON.stringify({ error: "Only owner/admin can update publication state" }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }
      ),
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/ready`,
      {
        method: "PATCH",
        body: JSON.stringify({ isPublished: true }),
        headers: { "Content-Type": "application/json" },
      }
    );
    const response = await patchReady(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(403);
    expect(prisma.catalogEntry.findUnique).not.toHaveBeenCalled();
  });

  it("returns 400 when trying to publish an incomplete recording", async () => {
    requireCatalogManagementAccess.mockResolvedValue({
      ok: true,
      userId: "owner-1",
    });
    prisma.catalogEntry.findUnique.mockResolvedValue({
      audioHash: HASH,
      isActionable: false,
      isPublished: false,
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/ready`,
      {
        method: "PATCH",
        body: JSON.stringify({ isPublished: true }),
        headers: { "Content-Type": "application/json" },
      }
    );
    const response = await patchReady(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(400);
    expect(prisma.catalogEntry.update).not.toHaveBeenCalled();
  });

  it("returns 400 when trying to unpublish a recording from a released event", async () => {
    requireCatalogManagementAccess.mockResolvedValue({
      ok: true,
      userId: "owner-1",
    });
    prisma.catalogEntry.findUnique.mockResolvedValue({
      audioHash: HASH,
      isActionable: true,
      isPublished: true,
    });
    prisma.catalogEventRecording.findUnique.mockResolvedValue({
      event: {
        released: true,
      },
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/ready`,
      {
        method: "PATCH",
        body: JSON.stringify({ isPublished: false }),
        headers: { "Content-Type": "application/json" },
      }
    );
    const response = await patchReady(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(400);
    expect(prisma.catalogEntry.update).not.toHaveBeenCalled();
  });
});
