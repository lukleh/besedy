import { beforeEach, describe, expect, it, vi } from "vitest";
import { assignIntakeEvent } from "@/lib/ingest/event";
import type { IntakeRow } from "@/lib/ingest/server";

const mocks = vi.hoisted(() => {
  const tx = {
    audioMetadata: { upsert: vi.fn() },
    workflowGroup: { update: vi.fn() },
    catalogEventRecording: { findUnique: vi.fn() },
  };
  return {
    tx,
    findAssignment: vi.fn(),
    transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    createEventFromRecording: vi.fn(),
    logMetadataUpdated: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  default: {
    $transaction: mocks.transaction,
    catalogEventRecording: { findUnique: mocks.findAssignment },
  },
}));
vi.mock("@/lib/catalog-events/create-from-recording", () => ({
  createEventFromRecording: mocks.createEventFromRecording,
}));
vi.mock("@/lib/audit/logger", () => ({ logMetadataUpdated: mocks.logMetadataUpdated }));

const CATALOG_ID = "20260201_120000";
const HASH = "c".repeat(64);

function intake(overrides: Partial<IntakeRow> = {}): IntakeRow {
  return {
    id: "intake-1",
    workflowGroupId: CATALOG_ID,
    requestedById: "admin-1",
    locationId: 7,
    dateYear: 2026,
    dateMonth: 11,
    dateDay: 17,
    eventId: null,
    ...overrides,
  } as IntakeRow;
}

describe("assignIntakeEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logMetadataUpdated.mockResolvedValue(undefined);
    mocks.tx.catalogEventRecording.findUnique.mockResolvedValue(null);
    mocks.findAssignment.mockResolvedValue(null);
  });

  it("does nothing for an upload without a place and date", async () => {
    const outcome = await assignIntakeEvent(intake({ locationId: null, dateYear: null }), HASH);

    expect(outcome).toEqual({ eventId: null, errorCode: null, errorMessage: null });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("stores the metadata and creates the event in one transaction", async () => {
    mocks.createEventFromRecording.mockResolvedValue({
      kind: "created",
      eventId: 42,
      title: "Praha 17. 11. 2026",
      sessionIndex: 1,
    });

    const outcome = await assignIntakeEvent(intake(), HASH);

    expect(outcome).toEqual({ eventId: 42, errorCode: null, errorMessage: null });
    const metadata = { locationId: 7, dateYear: 2026, dateMonth: 11, dateDay: 17 };
    expect(mocks.tx.audioMetadata.upsert).toHaveBeenCalledWith({
      where: { workflowGroupId_audioHash: { workflowGroupId: CATALOG_ID, audioHash: HASH } },
      update: metadata,
      create: { workflowGroupId: CATALOG_ID, audioHash: HASH, tags: [], verified: false, ...metadata },
    });
    expect(mocks.createEventFromRecording).toHaveBeenCalledWith(mocks.tx, {
      workflowGroupId: CATALOG_ID,
      audioHash: HASH,
      userId: "admin-1",
    });
    expect(mocks.logMetadataUpdated).toHaveBeenCalledWith("admin-1", HASH, CATALOG_ID, [
      "locationId",
      "dateYear",
      "dateMonth",
      "dateDay",
    ]);
  });

  it("keeps an existing assignment and its metadata untouched", async () => {
    mocks.tx.catalogEventRecording.findUnique.mockResolvedValue({ eventId: 42 });

    expect(await assignIntakeEvent(intake(), HASH)).toEqual({
      eventId: 42,
      errorCode: null,
      errorMessage: null,
    });
    expect(mocks.tx.audioMetadata.upsert).not.toHaveBeenCalled();
    expect(mocks.createEventFromRecording).not.toHaveBeenCalled();
    expect(mocks.logMetadataUpdated).not.toHaveBeenCalled();
  });

  it("reports the event of a concurrent completion that assigned the recording first", async () => {
    mocks.transaction.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );
    mocks.findAssignment.mockResolvedValue({ eventId: 42 });

    expect(await assignIntakeEvent(intake(), HASH)).toEqual({
      eventId: 42,
      errorCode: null,
      errorMessage: null,
    });
  });

  it("leaves the recording unassigned when events already cover the place and date", async () => {
    mocks.createEventFromRecording.mockResolvedValue({
      kind: "needs_destination_decision",
      details: {
        reason: "EVENT_CREATION_REQUIRES_DECISION",
        candidates: [
          { id: 5, title: "Praha 17. 11. 2026", sessionIndex: 1, recordingCount: 1, primaryTitle: null },
        ],
      },
    });

    const outcome = await assignIntakeEvent(intake(), HASH);

    expect(outcome.eventId).toBeNull();
    expect(outcome.errorCode).toBe("event_exists");
    expect(outcome.errorMessage).toContain("Praha 17. 11. 2026");
  });

  it("reports a failed transaction without throwing", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("deadlock"));

    const outcome = await assignIntakeEvent(intake(), HASH);

    expect(outcome).toMatchObject({ eventId: null, errorCode: "event_not_created" });
    expect(outcome.errorMessage).toContain("deadlock");
  });

  it("does not report a committed event as failed when the audit entry fails", async () => {
    mocks.createEventFromRecording.mockResolvedValue({
      kind: "created",
      eventId: 42,
      title: "t",
      sessionIndex: 1,
    });
    mocks.logMetadataUpdated.mockRejectedValue(new Error("audit down"));

    expect(await assignIntakeEvent(intake(), HASH)).toMatchObject({ eventId: 42, errorCode: null });
  });

  it("creates no event when the uploader no longer exists", async () => {
    const outcome = await assignIntakeEvent(intake({ requestedById: null }), HASH);

    expect(outcome.errorCode).toBe("event_not_created");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
