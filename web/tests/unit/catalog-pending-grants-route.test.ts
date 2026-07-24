import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  GET as getPendingCatalogGrants,
  POST as postPendingCatalogGrant,
} from "@/app/api/catalogs/[id]/pending-catalog-grants/route";

const mocks = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveCatalogManagementActorMock: vi.fn(),
  listPendingCatalogUsersMock: vi.fn(),
  createPendingCatalogGrantMock: vi.fn(),
}));

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: mocks.requireAuthMock,
}));

vi.mock("@/lib/access/catalog-management-route-access", () => ({
  resolveCatalogManagementActor: mocks.resolveCatalogManagementActorMock,
}));

vi.mock("@/lib/admission/catalog-read-models", () => ({
  listPendingCatalogUsers: mocks.listPendingCatalogUsersMock,
}));

vi.mock("@/lib/admission/catalog-pending-grant-create", () => ({
  createPendingCatalogGrant: mocks.createPendingCatalogGrantMock,
}));

describe("catalog pending grants route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthMock.mockResolvedValue("owner-1");
    mocks.resolveCatalogManagementActorMock.mockResolvedValue({
      ok: true,
      userId: "owner-1",
      catalogId: "20260101_000000",
      actor: { catalogExists: true, isCatalogAdmin: false },
      policyContext: {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: "OWNER",
        isCatalogAdmin: false,
      },
    });
    mocks.listPendingCatalogUsersMock.mockResolvedValue([]);
    mocks.createPendingCatalogGrantMock.mockResolvedValue(
      NextResponse.json({ id: "pending@example.com", email: "pending@example.com" })
    );
  });

  it("returns pending catalog grants directly for the same catalog", async () => {
    const response = await getPendingCatalogGrants(
      new NextRequest("http://localhost/api/catalogs/20260101_000000/pending-catalog-grants"),
      {
        params: Promise.resolve({ id: "20260101_000000" }),
      }
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveCatalogManagementActorMock).toHaveBeenCalledWith(
      "20260101_000000",
      { userId: "owner-1", activeCatalogOnly: false }
    );
    expect(mocks.listPendingCatalogUsersMock).toHaveBeenCalledWith("20260101_000000");
    await expect(response.json()).resolves.toEqual({
      pendingUsers: [],
    });
  });

  it("rejects users without catalog-management access", async () => {
    mocks.resolveCatalogManagementActorMock.mockResolvedValue({
      ok: true,
      userId: "owner-1",
      catalogId: "20260101_000000",
      actor: { catalogExists: true, isCatalogAdmin: false },
      policyContext: {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: "VIEWER",
        isCatalogAdmin: false,
      },
    });

    const response = await getPendingCatalogGrants(
      new NextRequest("http://localhost/api/catalogs/20260101_000000/pending-catalog-grants"),
      {
        params: Promise.resolve({ id: "20260101_000000" }),
      }
    );

    expect(response.status).toBe(403);
  });

  it("returns 404 when the catalog is missing", async () => {
    mocks.resolveCatalogManagementActorMock.mockResolvedValue({
      ok: true,
      userId: "admin-1",
      catalogId: "20260101_000000",
      actor: { isCatalogAdmin: true, catalogExists: false },
      policyContext: {
        catalogExists: false,
        canEnterPortal: true,
        catalogGrant: null,
        isCatalogAdmin: true,
      },
    });

    const response = await getPendingCatalogGrants(
      new NextRequest("http://localhost/api/catalogs/20260101_000000/pending-catalog-grants"),
      {
        params: Promise.resolve({ id: "20260101_000000" }),
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Catalog not found",
      code: "NOT_FOUND",
    });
    expect(mocks.listPendingCatalogUsersMock).not.toHaveBeenCalled();
  });

  it("uses the shared pending-catalog-grant create handler for POST", async () => {
    mocks.createPendingCatalogGrantMock.mockResolvedValue(
      NextResponse.json({
        id: "pending@example.com",
        email: "pending@example.com",
        userStatus: "PENDING",
      })
    );

    const request = new NextRequest(
      "http://localhost/api/catalogs/20260101_000000/pending-catalog-grants",
      {
        method: "POST",
        body: JSON.stringify({ email: "pending@example.com", accessLevel: "EDITOR" }),
      }
    );

    const response = await postPendingCatalogGrant(request, {
      params: Promise.resolve({ id: "20260101_000000" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.createPendingCatalogGrantMock).toHaveBeenCalledWith(
      request,
      "20260101_000000"
    );
    await expect(response.json()).resolves.toEqual({
      id: "pending@example.com",
      email: "pending@example.com",
      userStatus: "PENDING",
      type: "pending_catalog_grant",
    });
  });
});
