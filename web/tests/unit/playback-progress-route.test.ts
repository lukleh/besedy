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
    mocks.findUnique.mockResolvedValue(null);
  });

  function putProgress(body: {
    positionSec: number;
    durationSec: number | null;
    completed: boolean;
  }) {
    return PUT(
      new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/progress`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost",
          },
          body: JSON.stringify(body),
        },
      ),
      { params },
    );
  }

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

  it("completes playback that reaches the end without an ended event", async () => {
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
          positionSec: 99,
          durationSec: 100,
          completed: false,
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

  it("keeps playback that stops before the end tolerance in progress", async () => {
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
          positionSec: 98,
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

  describe("re-sent positions", () => {
    const saved = { positionSec: 42, durationSec: 100, completedAt: null };

    beforeEach(() => {
      mocks.findUnique.mockResolvedValue(saved);
      mocks.upsert.mockImplementation(async ({ update }) => ({
        ...saved,
        ...update,
      }));
    });

    it("leaves the row untouched when the position is already saved", async () => {
      const response = await putProgress({
        positionSec: 42.2,
        durationSec: 100,
        completed: false,
      });

      expect(response.status).toBe(200);
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({
        progress: { positionSec: 42, durationSec: 100, completed: false },
      });
    });

    it("leaves the row untouched when only a missing duration is re-sent", async () => {
      await putProgress({ positionSec: 42, durationSec: null, completed: false });

      expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it("reports a completed row as completed without rewriting it", async () => {
      mocks.findUnique.mockResolvedValue({
        ...saved,
        completedAt: new Date("2026-10-01T10:00:00Z"),
      });

      const response = await putProgress({
        positionSec: 42,
        durationSec: 100,
        completed: false,
      });

      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({
        progress: { completed: true },
      });
    });

    it("saves a position that moved", async () => {
      await putProgress({ positionSec: 57, durationSec: 100, completed: false });

      expect(mocks.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ positionSec: 57 }),
        }),
      );
    });

    it("saves a newly known duration", async () => {
      mocks.findUnique.mockResolvedValue({ ...saved, durationSec: null });

      await putProgress({ positionSec: 42, durationSec: 100, completed: false });

      expect(mocks.upsert).toHaveBeenCalled();
    });

    it("always saves a completion", async () => {
      await putProgress({ positionSec: 42, durationSec: 100, completed: true });

      expect(mocks.findUnique).not.toHaveBeenCalled();
      expect(mocks.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ completedAt: expect.any(Date) }),
        }),
      );
    });
  });
});
