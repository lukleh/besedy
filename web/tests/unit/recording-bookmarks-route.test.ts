import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  GET,
  POST,
} from "@/app/api/catalogs/[id]/recordings/[hash]/bookmarks/route";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
  requireCatalogRecordingAccess: vi.fn(),
  resolveCatalogRecordingRouteAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    recordingBookmark: {
      findMany: mocks.findMany,
      create: mocks.create,
    },
  },
}));

vi.mock("@/lib/access/catalog-recording-route-access", () => ({
  requireCatalogRecordingAccess: mocks.requireCatalogRecordingAccess,
  resolveCatalogRecordingRouteAccess: mocks.resolveCatalogRecordingRouteAccess,
}));

const CATALOG_ID = "20260101_120000";
const HASH = "a".repeat(64);
const URL = `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/bookmarks`;
const params = Promise.resolve({ id: CATALOG_ID, hash: HASH });
const CREATED = new Date("2026-10-03T12:00:00Z");

function postRequest(body: unknown, origin = "http://localhost") {
  return new NextRequest(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

describe("recording bookmarks route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCatalogRecordingRouteAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      catalogId: CATALOG_ID,
      hash: HASH,
      capability: { canAccessRecording: true },
    });
    mocks.requireCatalogRecordingAccess.mockResolvedValue(null);
    mocks.create.mockImplementation(async ({ data }) => ({
      id: "bookmark000000000000000001",
      positionSec: data.positionSec,
      comment: data.comment,
      excerpt: data.excerpt,
      createdAt: CREATED,
      updatedAt: CREATED,
    }));
  });

  it("lists only the current user's bookmarks in this recording, in playback order", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "bookmark000000000000000001",
        positionSec: 12.5,
        comment: "Opening",
        excerpt: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ]);

    const response = await GET(new NextRequest(URL), { params });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bookmarks: [
        {
          id: "bookmark000000000000000001",
          positionSec: 12.5,
          comment: "Opening",
          excerpt: null,
          createdAt: CREATED.toISOString(),
          updatedAt: CREATED.toISOString(),
        },
      ],
    });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", workflowGroupId: CATALOG_ID, audioHash: HASH },
        orderBy: [{ positionSec: "asc" }, { createdAt: "asc" }],
      }),
    );
  });

  it("creates a bookmark for the current user, storing a blank comment as none", async () => {
    const response = await POST(
      postRequest({ positionSec: 754.2, comment: "   ", excerpt: " Dobrý večer. " }),
      { params },
    );

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        workflowGroupId: CATALOG_ID,
        audioHash: HASH,
        positionSec: 754.2,
        comment: null,
        excerpt: "Dobrý večer.",
      },
      select: expect.any(Object),
    });
    expect(await response.json()).toMatchObject({
      bookmark: { positionSec: 754.2, comment: null, excerpt: "Dobrý večer." },
    });
  });

  it.each([
    ["a negative position", { positionSec: -1 }],
    ["a missing position", { comment: "x" }],
    ["an overlong comment", { positionSec: 1, comment: "x".repeat(2001) }],
    ["an overlong excerpt", { positionSec: 1, excerpt: "x".repeat(501) }],
  ])("rejects %s", async (_label, body) => {
    const response = await POST(postRequest(body), { params });

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not bookmark a recording the user cannot open", async () => {
    mocks.requireCatalogRecordingAccess.mockResolvedValue(
      NextResponse.json({ error: "Recording not found in catalog" }, { status: 404 }),
    );

    const response = await POST(postRequest({ positionSec: 5 }), { params });

    expect(response.status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    const response = await POST(
      postRequest({ positionSec: 5 }, "https://evil.example"),
      { params },
    );

    expect(response.status).toBe(403);
    expect(mocks.resolveCatalogRecordingRouteAccess).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
