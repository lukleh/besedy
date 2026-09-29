import { beforeEach, describe, expect, it, vi } from "vitest";
import { replaceLostPrimaryRecording } from "@/lib/catalog-events/primary-succession";

const tx = vi.hoisted(() => ({
  catalogEventRecording: { findMany: vi.fn(), update: vi.fn() },
  catalogEntry: { findMany: vi.fn(), updateMany: vi.fn() },
  catalogEvent: { findUnique: vi.fn(), updateMany: vi.fn() },
  workflowGroup: { update: vi.fn() },
}));

const CATALOG_ID = "20260201_120000";
const EVENT_ID = 42;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

async function run() {
  return replaceLostPrimaryRecording(tx as never, CATALOG_ID, EVENT_ID);
}

describe("replaceLostPrimaryRecording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.catalogEntry.updateMany.mockResolvedValue({ count: 1 });
    tx.catalogEvent.updateMany.mockResolvedValue({ count: 1 });
  });

  it("promotes the next playable recording and publishes it in a released event", async () => {
    tx.catalogEventRecording.findMany.mockResolvedValue([
      { audioHash: HASH_A, isPrimary: false },
      { audioHash: HASH_B, isPrimary: false },
    ]);
    // HASH_A comes first by sort order but is not playable.
    tx.catalogEntry.findMany.mockResolvedValue([{ audioHash: HASH_B }]);
    tx.catalogEvent.findUnique.mockResolvedValue({ released: true });

    await expect(run()).resolves.toEqual({ kind: "promoted", audioHash: HASH_B });

    expect(tx.catalogEventRecording.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workflowGroupId: CATALOG_ID, eventId: EVENT_ID },
        orderBy: [{ sortOrder: "asc" }, { audioHash: "asc" }],
      }),
    );
    expect(tx.catalogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workflowGroupId: CATALOG_ID,
          audioHash: { in: [HASH_A, HASH_B] },
          isActionable: true,
        },
      }),
    );
    expect(tx.catalogEventRecording.update).toHaveBeenCalledWith({
      where: {
        workflowGroupId_audioHash: { workflowGroupId: CATALOG_ID, audioHash: HASH_B },
      },
      data: { isPrimary: true },
    });
    expect(tx.catalogEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ audioHash: { in: [HASH_B] } }),
        data: { isPublished: true },
      }),
    );
    expect(tx.catalogEvent.updateMany).not.toHaveBeenCalled();
  });

  it("promotes without publishing in an unreleased event", async () => {
    tx.catalogEventRecording.findMany.mockResolvedValue([
      { audioHash: HASH_A, isPrimary: false },
    ]);
    tx.catalogEntry.findMany.mockResolvedValue([{ audioHash: HASH_A }]);
    tx.catalogEvent.findUnique.mockResolvedValue({ released: false });

    await expect(run()).resolves.toEqual({ kind: "promoted", audioHash: HASH_A });

    expect(tx.catalogEntry.updateMany).not.toHaveBeenCalled();
  });

  it("unreleases the event and keeps it when no playable recording is left", async () => {
    tx.catalogEventRecording.findMany.mockResolvedValue([
      { audioHash: HASH_A, isPrimary: false },
    ]);
    tx.catalogEntry.findMany.mockResolvedValue([]);

    await expect(run()).resolves.toEqual({ kind: "unreleased" });

    expect(tx.catalogEventRecording.update).not.toHaveBeenCalled();
    expect(tx.catalogEvent.updateMany).toHaveBeenCalledWith({
      where: { id: EVENT_ID, workflowGroupId: CATALOG_ID, released: true },
      data: { released: false },
    });
  });

  it("reports unchanged when an event with no recordings left was not released", async () => {
    tx.catalogEventRecording.findMany.mockResolvedValue([]);
    tx.catalogEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(run()).resolves.toEqual({ kind: "unchanged" });

    expect(tx.catalogEntry.findMany).not.toHaveBeenCalled();
  });

  it("leaves the event alone when it already has another primary", async () => {
    tx.catalogEventRecording.findMany.mockResolvedValue([
      { audioHash: HASH_A, isPrimary: true },
    ]);

    await expect(run()).resolves.toEqual({ kind: "unchanged" });

    expect(tx.catalogEventRecording.update).not.toHaveBeenCalled();
    expect(tx.catalogEvent.updateMany).not.toHaveBeenCalled();
  });
});
