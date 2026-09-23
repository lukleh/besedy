import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, tx, logAuditEvent, storage } = vi.hoisted(() => {
  const transactionClient = {
    $queryRaw: vi.fn(),
    catalogEventArtwork: {
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    catalogEventArtworkPublication: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
  };
  return {
    tx: transactionClient,
    prisma: {
      $transaction: vi.fn((callback: (client: typeof transactionClient) => unknown) => callback(transactionClient)),
      catalogEventArtwork: { findMany: vi.fn(), findFirst: vi.fn() },
      catalogEventArtworkPublication: { findMany: vi.fn(), findUnique: vi.fn() },
    },
    logAuditEvent: vi.fn(),
    storage: {
      finalizeStagedEventArtworkAssetsRemoval: vi.fn(),
      getArtworkContentType: vi.fn(),
      processArtworkAsset: vi.fn(),
      readArtworkAsset: vi.fn(),
      removeArtworkCandidateAssets: vi.fn(),
      resolveEventArtworkAssetPath: vi.fn(),
      restoreStagedEventArtworkAssets: vi.fn(),
      stageArtworkCandidateAssetsRemoval: vi.fn(),
      writeArtworkCandidateAssets: vi.fn(),
    },
  };
});

vi.mock("@/lib/db", () => ({ default: prisma }));
vi.mock("@/lib/audit/logger", () => ({ logAuditEvent }));
vi.mock("@/lib/event-artwork-storage", () => storage);

import {
  EventArtworkServiceError,
  deleteEventArtworkCandidate,
  getEventArtworkWorkflowStatuses,
  getLatestEventArtworkCandidate,
  loadEventArtworkAsset,
  publishEventArtwork,
} from "@/lib/event-artwork-service";

describe("event artwork service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([{ id: 7 }]);
    tx.catalogEventArtwork.delete.mockResolvedValue({});
    storage.finalizeStagedEventArtworkAssetsRemoval.mockResolvedValue(undefined);
    storage.restoreStagedEventArtworkAssets.mockResolvedValue(undefined);
    storage.stageArtworkCandidateAssetsRemoval.mockResolvedValue(null);
  });

  it("summarizes draft and published workflow states in bulk", async () => {
    prisma.catalogEventArtwork.findMany.mockResolvedValue([
      { eventId: 1, createdAt: new Date("2026-01-01T00:00:00Z") },
      { eventId: 2, createdAt: new Date("2026-02-01T00:00:00Z") },
      { eventId: 3, createdAt: new Date("2026-03-02T00:00:00Z") },
    ]);
    prisma.catalogEventArtworkPublication.findMany.mockResolvedValue([
      { eventId: 2, publishedAt: new Date("2026-02-02T00:00:00Z") },
      { eventId: 3, publishedAt: new Date("2026-03-01T00:00:00Z") },
    ]);

    const result = await getEventArtworkWorkflowStatuses("20260101_000000", [1, 2, 3, 4]);

    expect(Object.fromEntries(result)).toEqual({
      1: "draft-only",
      2: "published",
      3: "published-with-newer-drafts",
      4: "none",
    });
  });

  it("returns the most recently created candidate for a preview", async () => {
    prisma.catalogEventArtwork.findFirst.mockResolvedValue({
      id: "candidate-1",
      label: "Cover draft",
      createdAt: new Date("2026-03-02T00:00:00Z"),
    });

    const result = await getLatestEventArtworkCandidate("20260101_000000", 7);

    expect(result).toEqual({
      id: "candidate-1",
      label: "Cover draft",
      createdAt: "2026-03-02T00:00:00.000Z",
    });
    expect(prisma.catalogEventArtwork.findFirst).toHaveBeenCalledWith({
      where: { workflowGroupId: "20260101_000000", eventId: 7 },
      select: { id: true, label: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });

  it("returns null when no candidate exists for a preview", async () => {
    prisma.catalogEventArtwork.findFirst.mockResolvedValue(null);

    await expect(getLatestEventArtworkCandidate("20260101_000000", 7)).resolves.toBeNull();
  });

  it("publishes a candidate atomically and records the replaced candidate", async () => {
    tx.catalogEventArtwork.findFirst.mockResolvedValue({ id: "new-artwork" });
    tx.catalogEventArtworkPublication.findUnique.mockResolvedValue({
      artworkId: "old-artwork",
    });

    const result = await publishEventArtwork({
      catalogId: "20260101_000000",
      eventId: 7,
      artworkId: "new-artwork",
      userId: "owner-1",
    });

    expect(result).toEqual({ changed: true, previousArtworkId: "old-artwork" });
    expect(tx.catalogEventArtworkPublication.upsert).toHaveBeenCalledOnce();
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EVENT_ARTWORK_PUBLISHED",
        outcome: "changed",
        payload: expect.objectContaining({ previousArtworkId: "old-artwork" }),
      })
    );
  });

  it("fails publication when the scoped event does not exist", async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(
      publishEventArtwork({
        catalogId: "20260101_000000",
        eventId: 999,
        artworkId: "missing",
        userId: "owner-1",
      })
    ).rejects.toMatchObject({
      name: "EventArtworkServiceError",
      statusCode: 404,
    } satisfies Partial<EventArtworkServiceError>);
    expect(tx.catalogEventArtwork.findFirst).not.toHaveBeenCalled();
  });

  it("records candidate deletion before best-effort asset finalization", async () => {
    const staged = {
      originalPath: "/artworks/live",
      stagedPath: "/artworks/deleted",
    };
    tx.catalogEventArtwork.findFirst.mockResolvedValue({
      id: "artwork-1",
      publication: null,
    });
    storage.stageArtworkCandidateAssetsRemoval.mockResolvedValue(staged);
    storage.finalizeStagedEventArtworkAssetsRemoval.mockRejectedValue(new Error("busy"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      deleteEventArtworkCandidate({
        catalogId: "20260101_000000",
        eventId: 7,
        artworkId: "artwork-1",
        userId: "owner-1",
      })
    ).resolves.toBeUndefined();

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EVENT_ARTWORK_DELETED",
        resourceId: "artwork-1",
      })
    );
    expect(storage.finalizeStagedEventArtworkAssetsRemoval).toHaveBeenCalledWith(staged);
    expect(consoleError).toHaveBeenCalled();
  });

  it("restores staged candidate assets when database deletion fails", async () => {
    const staged = {
      originalPath: "/artworks/live",
      stagedPath: "/artworks/deleted",
    };
    tx.catalogEventArtwork.findFirst.mockResolvedValue({
      id: "artwork-1",
      publication: null,
    });
    tx.catalogEventArtwork.delete.mockRejectedValue(new Error("database unavailable"));
    storage.stageArtworkCandidateAssetsRemoval.mockResolvedValue(staged);

    await expect(
      deleteEventArtworkCandidate({
        catalogId: "20260101_000000",
        eventId: 7,
        artworkId: "artwork-1",
        userId: "owner-1",
      })
    ).rejects.toThrow("database unavailable");

    expect(storage.restoreStagedEventArtworkAssets).toHaveBeenCalledWith(staged);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("treats a missing artwork file as a missing asset", async () => {
    prisma.catalogEventArtwork.findFirst.mockResolvedValue({
      id: "artwork-1",
      squareExtension: ".png",
      landscapeExtension: ".jpg",
    });
    storage.resolveEventArtworkAssetPath.mockReturnValue("/artworks/missing.png");
    storage.readArtworkAsset.mockResolvedValue(null);

    await expect(
      loadEventArtworkAsset({
        catalogId: "20260101_000000",
        eventId: 7,
        artworkId: "artwork-1",
        variant: "square",
        publishedOnly: false,
      })
    ).resolves.toBeNull();
  });
});
