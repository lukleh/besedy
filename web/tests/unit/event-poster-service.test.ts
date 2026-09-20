import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, tx, logAuditEvent, storage } = vi.hoisted(() => {
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
      catalogEventPoster: { findMany: vi.fn(), findFirst: vi.fn() },
      catalogEventPosterPublication: { findMany: vi.fn(), findUnique: vi.fn() },
    },
    logAuditEvent: vi.fn(),
    storage: {
      finalizeStagedEventPosterAssetsRemoval: vi.fn(),
      getPosterContentType: vi.fn(),
      processPosterAsset: vi.fn(),
      readPosterAsset: vi.fn(),
      removePosterCandidateAssets: vi.fn(),
      resolveEventPosterAssetPath: vi.fn(),
      restoreStagedEventPosterAssets: vi.fn(),
      stagePosterCandidateAssetsRemoval: vi.fn(),
      writePosterCandidateAssets: vi.fn(),
    },
  };
});

vi.mock("@/lib/db", () => ({ default: prisma }));
vi.mock("@/lib/audit/logger", () => ({ logAuditEvent }));
vi.mock("@/lib/event-poster-storage", () => storage);

import {
  EventPosterServiceError,
  deleteEventPosterCandidate,
  getEventPosterWorkflowStatuses,
  getLatestEventPosterCandidate,
  loadEventPosterAsset,
  publishEventPoster,
} from "@/lib/event-poster-service";

describe("event poster service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([{ id: 7 }]);
    tx.catalogEventPoster.delete.mockResolvedValue({});
    storage.finalizeStagedEventPosterAssetsRemoval.mockResolvedValue(undefined);
    storage.restoreStagedEventPosterAssets.mockResolvedValue(undefined);
    storage.stagePosterCandidateAssetsRemoval.mockResolvedValue(null);
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

  it("returns the most recently created candidate for a preview", async () => {
    prisma.catalogEventPoster.findFirst.mockResolvedValue({
      id: "candidate-1",
      label: "Cover draft",
      createdAt: new Date("2026-03-02T00:00:00Z"),
    });

    const result = await getLatestEventPosterCandidate("20260101_000000", 7);

    expect(result).toEqual({
      id: "candidate-1",
      label: "Cover draft",
      createdAt: "2026-03-02T00:00:00.000Z",
    });
    expect(prisma.catalogEventPoster.findFirst).toHaveBeenCalledWith({
      where: { workflowGroupId: "20260101_000000", eventId: 7 },
      select: { id: true, label: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });

  it("returns null when no candidate exists for a preview", async () => {
    prisma.catalogEventPoster.findFirst.mockResolvedValue(null);

    await expect(getLatestEventPosterCandidate("20260101_000000", 7)).resolves.toBeNull();
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

  it("records candidate deletion before best-effort asset finalization", async () => {
    const staged = {
      originalPath: "/posters/live",
      stagedPath: "/posters/deleted",
    };
    tx.catalogEventPoster.findFirst.mockResolvedValue({
      id: "poster-1",
      publication: null,
    });
    storage.stagePosterCandidateAssetsRemoval.mockResolvedValue(staged);
    storage.finalizeStagedEventPosterAssetsRemoval.mockRejectedValue(new Error("busy"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      deleteEventPosterCandidate({
        catalogId: "20260101_000000",
        eventId: 7,
        posterId: "poster-1",
        userId: "owner-1",
      })
    ).resolves.toBeUndefined();

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EVENT_POSTER_DELETED",
        resourceId: "poster-1",
      })
    );
    expect(storage.finalizeStagedEventPosterAssetsRemoval).toHaveBeenCalledWith(staged);
    expect(consoleError).toHaveBeenCalled();
  });

  it("restores staged candidate assets when database deletion fails", async () => {
    const staged = {
      originalPath: "/posters/live",
      stagedPath: "/posters/deleted",
    };
    tx.catalogEventPoster.findFirst.mockResolvedValue({
      id: "poster-1",
      publication: null,
    });
    tx.catalogEventPoster.delete.mockRejectedValue(new Error("database unavailable"));
    storage.stagePosterCandidateAssetsRemoval.mockResolvedValue(staged);

    await expect(
      deleteEventPosterCandidate({
        catalogId: "20260101_000000",
        eventId: 7,
        posterId: "poster-1",
        userId: "owner-1",
      })
    ).rejects.toThrow("database unavailable");

    expect(storage.restoreStagedEventPosterAssets).toHaveBeenCalledWith(staged);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("treats a missing poster file as a missing asset", async () => {
    prisma.catalogEventPoster.findFirst.mockResolvedValue({
      id: "poster-1",
      squareExtension: ".png",
      landscapeExtension: ".jpg",
    });
    storage.resolveEventPosterAssetPath.mockReturnValue("/posters/missing.png");
    storage.readPosterAsset.mockResolvedValue(null);

    await expect(
      loadEventPosterAsset({
        catalogId: "20260101_000000",
        eventId: 7,
        posterId: "poster-1",
        variant: "square",
        publishedOnly: false,
      })
    ).resolves.toBeNull();
  });
});
