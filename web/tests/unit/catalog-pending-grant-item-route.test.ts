import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  DELETE as deletePendingCatalogGrant,
  PUT as putPendingCatalogGrant,
} from "@/app/api/catalogs/[id]/pending-catalog-grants/[email]/route";

const mocks = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  putMock: vi.fn(),
}));

vi.mock("@/lib/admission/catalog-pending-record-route", () => ({
  deletePendingCatalogRecord: mocks.deleteMock,
  updatePendingCatalogRecord: mocks.putMock,
}));

describe("catalog pending grant item route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteMock.mockResolvedValue(NextResponse.json({ ok: true }));
    mocks.putMock.mockResolvedValue(NextResponse.json({ ok: true }));
  });

  it("uses the shared catalog pending-record handler for DELETE", async () => {
    const request = new NextRequest(
      "http://localhost/api/catalogs/20260101_000000/pending-catalog-grants/pending@example.com",
      { method: "DELETE" }
    );

    const response = await deletePendingCatalogGrant(request, {
      params: Promise.resolve({
        id: "20260101_000000",
        email: "pending@example.com",
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.deleteMock).toHaveBeenCalledWith(
      "20260101_000000",
      "pending@example.com"
    );
  });

  it("uses the shared catalog pending-record handler for PUT", async () => {
    const request = new NextRequest(
      "http://localhost/api/catalogs/20260101_000000/pending-catalog-grants/pending@example.com",
      {
        method: "PUT",
        body: JSON.stringify({ accessLevel: "EDITOR" }),
      }
    );

    const response = await putPendingCatalogGrant(request, {
      params: Promise.resolve({
        id: "20260101_000000",
        email: "pending@example.com",
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.putMock).toHaveBeenCalledWith(
      "20260101_000000",
      "pending@example.com",
      request
    );
  });
});
