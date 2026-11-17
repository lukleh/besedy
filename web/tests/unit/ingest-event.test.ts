import { beforeEach, describe, expect, it, vi } from "vitest";
import { assignIntakeEvent } from "@/lib/ingest/event";
import type { IntakeRow } from "@/lib/ingest/server";

const mocks = vi.hoisted(() => {
  const tx = {
    audioMetadata: { upsert: vi.fn() },
    workflowGroup: { update: vi.fn() },
    catalogEventRecording: { findUnique: vi.fn() },
    recordingIntake: { findFirst: vi.fn() },
  };
  return {
    tx,
    findAssignment: vi.fn(),
    attachRecordingsToEvent: vi.fn(),
    replaceLostPrimaryRecording: vi.fn(),
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
vi.mock("@/lib/catalog-events/attach-recordings", () => ({
  attachRecordingsToEvent: mocks.attachRecordingsToEvent,
}));
vi.mock("@/lib/catalog-events/primary-succession", () => ({
  replaceLostPrimaryRecording: mocks.replaceLostPrimaryRecording,
}));

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
    recorderId: null,
    uploadBatchId: null,
    targetEventId: null,
    createDistinctEvent: false,
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
    mocks.tx.recordingIntake.findFirst.mockResolvedValue(null);
    mocks.attachRecordingsToEvent.mockResolvedValue({
      kind: "success",
      attachedAudioHashes: [HASH],
      errors: [],
    });
  });

  it("adds the recording to the event chosen on upload", async () => {
    const outcome = await assignIntakeEvent(intake({ targetEventId: 9 }), HASH);

    expect(outcome).toEqual({ eventId: 9, errorCode: null, errorMessage: null });
    expect(mocks.attachRecordingsToEvent).toHaveBeenCalledWith(mocks.tx, {
      catalogId: CATALOG_ID,
      eventId: 9,
      audioHashes: [HASH],
    });
    expect(mocks.createEventFromRecording).not.toHaveBeenCalled();
    expect(mocks.tx.audioMetadata.upsert).toHaveBeenCalled();
    // An event left without a primary gets the joined recording as primary.
    expect(mocks.replaceLostPrimaryRecording).toHaveBeenCalledWith(mocks.tx, CATALOG_ID, 9);
    expect(mocks.replaceLostPrimaryRecording.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.attachRecordingsToEvent.mock.invocationCallOrder[0]
    );
  });

  it("adds a later file of the same upload to the event the first one got", async () => {
    const batch = "0b9c6c1e-5a61-4b7e-9d32-3c6f5f1a2b3c";
    mocks.tx.recordingIntake.findFirst.mockResolvedValue({ eventId: 42 });

    const outcome = await assignIntakeEvent(intake({ uploadBatchId: batch }), HASH);

    expect(outcome.eventId).toBe(42);
    expect(mocks.tx.recordingIntake.findFirst).toHaveBeenCalledWith({
      where: {
        workflowGroupId: CATALOG_ID,
        uploadBatchId: batch,
        id: { not: "intake-1" },
        eventId: { not: null },
      },
      orderBy: { finishedAt: "asc" },
      select: { eventId: true },
    });
    expect(mocks.createEventFromRecording).not.toHaveBeenCalled();
  });

  it("creates the event for the first file of an upload, separate when chosen", async () => {
    mocks.createEventFromRecording.mockResolvedValue({
      kind: "created",
      eventId: 43,
      title: "t",
      sessionIndex: 2,
    });

    const outcome = await assignIntakeEvent(
      intake({ uploadBatchId: "0b9c6c1e-5a61-4b7e-9d32-3c6f5f1a2b3c", createDistinctEvent: true }),
      HASH
    );

    expect(outcome.eventId).toBe(43);
    expect(mocks.createEventFromRecording).toHaveBeenCalledWith(mocks.tx, {
      workflowGroupId: CATALOG_ID,
      audioHash: HASH,
      userId: "admin-1",
      intent: "create_distinct",
    });
  });

  it("reports a recording that could not be added to the chosen event", async () => {
    mocks.attachRecordingsToEvent.mockResolvedValue({ kind: "event_not_found" });

    const outcome = await assignIntakeEvent(intake({ targetEventId: 9 }), HASH);

    expect(outcome).toMatchObject({ eventId: null, errorCode: "event_not_created" });
    expect(outcome.errorMessage).toContain("event #9");
    expect(mocks.replaceLostPrimaryRecording).not.toHaveBeenCalled();
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
      intent: undefined,
    });
    expect(mocks.logMetadataUpdated).toHaveBeenCalledWith("admin-1", HASH, CATALOG_ID, [
      "locationId",
      "dateYear",
      "dateMonth",
      "dateDay",
    ]);
  });

  it("saves a recorder given without a place and date, and creates no event", async () => {
    const outcome = await assignIntakeEvent(
      intake({ locationId: null, dateYear: null, dateMonth: null, dateDay: null, recorderId: 3 }),
      HASH
    );

    expect(outcome).toEqual({ eventId: null, errorCode: null, errorMessage: null });
    expect(mocks.tx.audioMetadata.upsert).toHaveBeenCalledWith({
      where: { workflowGroupId_audioHash: { workflowGroupId: CATALOG_ID, audioHash: HASH } },
      update: { recorderId: 3 },
      create: { workflowGroupId: CATALOG_ID, audioHash: HASH, tags: [], verified: false, recorderId: 3 },
    });
    expect(mocks.createEventFromRecording).not.toHaveBeenCalled();
    expect(mocks.logMetadataUpdated).toHaveBeenCalledWith("admin-1", HASH, CATALOG_ID, ["recorderId"]);
  });

  it("saves the recorder together with the place and date", async () => {
    mocks.createEventFromRecording.mockResolvedValue({
      kind: "created",
      eventId: 42,
      title: "t",
      sessionIndex: 1,
    });

    await assignIntakeEvent(intake({ recorderId: 3 }), HASH);

    expect(mocks.tx.audioMetadata.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { locationId: 7, dateYear: 2026, dateMonth: 11, dateDay: 17, recorderId: 3 },
      })
    );
  });

  it("reports a recorder-only failure as metadata_not_saved", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("deadlock"));

    const outcome = await assignIntakeEvent(
      intake({ locationId: null, dateYear: null, recorderId: 3 }),
      HASH
    );

    expect(outcome).toMatchObject({ eventId: null, errorCode: "metadata_not_saved" });
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

  it("reports a failed transaction without throwing, naming the lost metadata", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("deadlock"));
    const placeAndDate = await assignIntakeEvent(intake(), HASH);
    mocks.transaction.mockRejectedValueOnce(new Error("deadlock"));
    const withRecorder = await assignIntakeEvent(intake({ recorderId: 3 }), HASH);

    expect(placeAndDate).toMatchObject({ eventId: null, errorCode: "event_not_created" });
    expect(placeAndDate.errorMessage).toContain("place and date were not saved");
    expect(placeAndDate.errorMessage).toContain("deadlock");
    expect(withRecorder.errorMessage).toContain("place, date and recorder were not saved");
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

  it("writes nothing when the uploader no longer exists, so no change goes unaudited", async () => {
    const withEvent = await assignIntakeEvent(intake({ requestedById: null, recorderId: 3 }), HASH);
    const recorderOnly = await assignIntakeEvent(
      intake({ requestedById: null, locationId: null, dateYear: null, recorderId: 3 }),
      HASH
    );

    expect(withEvent.errorCode).toBe("event_not_created");
    expect(recorderOnly.errorCode).toBe("metadata_not_saved");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.logMetadataUpdated).not.toHaveBeenCalled();
  });
});
