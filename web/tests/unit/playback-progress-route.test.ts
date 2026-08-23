import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  GET,
  PUT,
} from "@/app/api/catalogs/[id]/recordings/[hash]/progress/route";
import { AuthError } from "@/lib/auth/permissions";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  requireCatalogRecordingAccess: vi.fn(),
  resolveCatalogRecordingRouteAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    recordingPlaybackProgress: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
  },
}));

vi.mock("@/lib/access/catalog-recording-route-access", () => ({
  requireCatalogRecordingAccess: mocks.requireCatalogRecordingAccess,
  resolveCatalogRecordingRouteAccess: mocks.resolveCatalogRecordingRouteAccess,
}));

const CATALOG_ID = "20260101_120000";
const HASH = "a".repeat(64);
const params = Promise.resolve({ id: CATALOG_ID, hash: HASH });

describe("recording playback progress route", () => {
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
  });

  it("returns the current user's progress", async () => {
    mocks.findUnique.mockResolvedValue({
      positionSec: 42,
      durationSec: 100,
      completedAt: null,
      updatedAt: new Date("2026-08-23T12:00:00Z"),
    });

    const response = await GET(
      new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/progress`,
      ),
      { params },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      progress: { positionSec: 42, durationSec: 100, completed: false },
    });
  });

  it("returns the authentication status instead of an internal error", async () => {
    mocks.resolveCatalogRecordingRouteAccess.mockRejectedValue(
      new AuthError("Authentication required", 401),
    );

    const response = await GET(
      new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/progress`,
      ),
      { params },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "Authentication required",
      code: "UNAUTHORIZED",
    });
  });

  it("marks playback complete only when the player reports its actual end", async () => {
    mocks.upsert.mockImplementation(async ({ create }) => ({
      positionSec: create.positionSec,
      durationSec: create.durationSec,
      completedAt: create.completedAt,
    }));
    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/progress`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          positionSec: 96,
          durationSec: 100,
          completed: true,
        }),
      },
    );

    const response = await PUT(request, { params });

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(await response.json()).toMatchObject({
      progress: { completed: true },
    });
  });

  it("keeps near-end playback in progress without an ended event", async () => {
    mocks.upsert.mockImplementation(async ({ create }) => ({
      positionSec: create.positionSec,
      durationSec: create.durationSec,
      completedAt: create.completedAt,
    }));
    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/progress`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          positionSec: 99.9,
          durationSec: 100,
          completed: false,
        }),
      },
    );

    const response = await PUT(request, { params });

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ completedAt: null }),
      }),
    );
    expect(await response.json()).toMatchObject({
      progress: { completed: false },
    });
  });

  it("preserves a known duration when a client sends no duration", async () => {
    mocks.upsert.mockResolvedValue({
      positionSec: 42,
      durationSec: 100,
      completedAt: null,
    });
    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/progress`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          positionSec: 42,
          durationSec: null,
          completed: false,
        }),
      },
    );

    const response = await PUT(request, { params });

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ durationSec: null }),
        update: expect.objectContaining({ durationSec: undefined }),
      }),
    );
  });
});
