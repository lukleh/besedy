import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeRecordingWebState } from "@/lib/ingest/removal";

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  catalogEventRecording: { findUnique: vi.fn(), delete: vi.fn() },
  catalogEvent: { update: vi.fn() },
  audioMetadata: { deleteMany: vi.fn() },
  recordingPlaybackProgress: { deleteMany: vi.fn() },
  recordingNotification: { deleteMany: vi.fn() },
  workflowGroup: { update: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  default: {
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  },
}));

const CATALOG_ID = "20260201_120000";
const HASH = "b".repeat(64);

describe("removeRecordingWebState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.audioMetadata.deleteMany.mockResolvedValue({ count: 1 });
    tx.recordingPlaybackProgress.deleteMany.mockResolvedValue({ count: 3 });
    tx.recordingNotification.deleteMany.mockResolvedValue({ count: 2 });
  });

  it("detaches the recording, unreleases an event that lost its primary, and deletes user-authored rows", async () => {
    tx.catalogEventRecording.findUnique.mockResolvedValue({
      eventId: 42,
      isPrimary: true,
      event: { released: true },
    });

    const result = await removeRecordingWebState(CATALOG_ID, HASH);

    expect(result).toEqual({
      detachedEventId: 42,
      unreleasedEventId: 42,
      metadataDeleted: 1,
      progressDeleted: 3,
      notificationsDeleted: 2,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.catalogEventRecording.delete).toHaveBeenCalledWith({
      where: { workflowGroupId_audioHash: { workflowGroupId: CATALOG_ID, audioHash: HASH } },
    });
    expect(tx.catalogEvent.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { released: false },
    });
    expect(tx.audioMetadata.deleteMany).toHaveBeenCalledWith({
      where: { workflowGroupId: CATALOG_ID, audioHash: HASH },
    });
    expect(tx.recordingPlaybackProgress.deleteMany).toHaveBeenCalledWith({
      where: { audioHash: HASH },
    });
    expect(tx.recordingNotification.deleteMany).toHaveBeenCalledWith({
      where: { catalogId: CATALOG_ID, audioHash: HASH },
    });
    expect(tx.workflowGroup.update).toHaveBeenCalled();
  });

  it("keeps a released event released when a non-primary recording is removed", async () => {
    tx.catalogEventRecording.findUnique.mockResolvedValue({
      eventId: 42,
      isPrimary: false,
      event: { released: true },
    });

    const result = await removeRecordingWebState(CATALOG_ID, HASH);

    expect(result.detachedEventId).toBe(42);
    expect(result.unreleasedEventId).toBeNull();
    expect(tx.catalogEvent.update).not.toHaveBeenCalled();
  });

  it("handles recordings that are not attached to any event", async () => {
    tx.catalogEventRecording.findUnique.mockResolvedValue(null);

    const result = await removeRecordingWebState(CATALOG_ID, HASH);

    expect(result.detachedEventId).toBeNull();
    expect(tx.catalogEventRecording.delete).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.audioMetadata.deleteMany).toHaveBeenCalled();
  });
});
