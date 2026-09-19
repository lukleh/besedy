import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, tx, logAuditEvent } = vi.hoisted(() => {
  const transactionClient = {
    $queryRaw: vi.fn(),
    catalogEventPoster: {
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    catalogEventPosterPublication: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
  };
  return {
    tx: transactionClient,
    prisma: {
      $transaction: vi.fn((callback: (client: typeof transactionClient) => unknown) => callback(transactionClient)),
      catalogEventPoster: { findMany: vi.fn() },
      catalogEventPosterPublication: { findMany: vi.fn() },
    },
    logAuditEvent: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ default: prisma }));
vi.mock("@/lib/audit/logger", () => ({ logAuditEvent }));
vi.mock("@/lib/event-poster-storage", () => ({
  getPosterContentType: vi.fn(),
  processPosterAsset: vi.fn(),
  readPosterAsset: vi.fn(),
  removePosterCandidateAssets: vi.fn(),
  resolveEventPosterAssetPath: vi.fn(),
  writePosterCandidateAssets: vi.fn(),
}));

import {
  EventPosterServiceError,
  getEventPosterWorkflowStatuses,
  publishEventPoster,
} from "@/lib/event-poster-service";

describe("event poster service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([{ id: 7 }]);
  });

  it("summarizes draft and published workflow states in bulk", async () => {
    prisma.catalogEventPoster.findMany.mockResolvedValue([
      { eventId: 1, createdAt: new Date("2026-01-01T00:00:00Z") },
      { eventId: 2, createdAt: new Date("2026-02-01T00:00:00Z") },
      { eventId: 3, createdAt: new Date("2026-03-02T00:00:00Z") },
    ]);
    prisma.catalogEventPosterPublication.findMany.mockResolvedValue([
      { eventId: 2, publishedAt: new Date("2026-02-02T00:00:00Z") },
      { eventId: 3, publishedAt: new Date("2026-03-01T00:00:00Z") },
    ]);

    const result = await getEventPosterWorkflowStatuses("20260101_000000", [1, 2, 3, 4]);

    expect(Object.fromEntries(result)).toEqual({
      1: "draft-only",
      2: "published",
      3: "published-with-newer-drafts",
      4: "none",
    });
  });

  it("publishes a candidate atomically and records the replaced candidate", async () => {
    tx.catalogEventPoster.findFirst.mockResolvedValue({ id: "new-poster" });
    tx.catalogEventPosterPublication.findUnique.mockResolvedValue({
      posterId: "old-poster",
    });

    const result = await publishEventPoster({
      catalogId: "20260101_000000",
      eventId: 7,
      posterId: "new-poster",
      userId: "owner-1",
    });

    expect(result).toEqual({ changed: true, previousPosterId: "old-poster" });
    expect(tx.catalogEventPosterPublication.upsert).toHaveBeenCalledOnce();
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EVENT_POSTER_PUBLISHED",
        outcome: "changed",
        payload: expect.objectContaining({ previousPosterId: "old-poster" }),
      })
    );
  });

  it("fails publication when the scoped event does not exist", async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(
      publishEventPoster({
        catalogId: "20260101_000000",
        eventId: 999,
        posterId: "missing",
        userId: "owner-1",
      })
    ).rejects.toMatchObject({
      name: "EventPosterServiceError",
      statusCode: 404,
    } satisfies Partial<EventPosterServiceError>);
    expect(tx.catalogEventPoster.findFirst).not.toHaveBeenCalled();
  });
});
