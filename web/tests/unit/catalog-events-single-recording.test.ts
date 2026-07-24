import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSingleRecordingEventState } from "@/lib/catalog-events/single-recording";

type EventStateClient = Parameters<typeof ensureSingleRecordingEventState>[0];

describe("single-recording event normalization", () => {
  const catalogId = "20260201_120000";
  const eventId = 42;
  const userId = "admin-user";
  const audioHash = "a".repeat(64);

  let client: {
    catalogEvent: {
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    catalogEventRecording: {
      findMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    client = {
      catalogEvent: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      catalogEventRecording: {
        findMany: vi.fn(),
        updateMany: vi.fn(),
      },
    };
  });

  it("promotes and releases a valid singleton event", async () => {
    client.catalogEvent.findUnique.mockResolvedValue({
      id: eventId,
      released: false,
    });
    client.catalogEventRecording.findMany.mockResolvedValue([
      { audioHash, isPrimary: false },
    ]);
    client.catalogEventRecording.updateMany.mockResolvedValue({ count: 1 });
    client.catalogEvent.updateMany.mockResolvedValue({ count: 1 });

    const changed = await ensureSingleRecordingEventState(
      client as unknown as EventStateClient,
      catalogId,
      eventId,
      userId
    );

    expect(changed).toBe(true);
    expect(client.catalogEventRecording.updateMany).toHaveBeenCalledWith({
      where: {
        eventId,
        workflowGroupId: catalogId,
        audioHash,
        isPrimary: false,
      },
      data: { isPrimary: true },
    });
    expect(client.catalogEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: eventId,
        workflowGroupId: catalogId,
        released: false,
        recordings: {
          some: {
            workflowGroupId: catalogId,
            audioHash,
            isPrimary: true,
          },
          every: {
            workflowGroupId: catalogId,
            audioHash,
          },
        },
      },
      data: {
        released: true,
        updatedById: userId,
      },
    });
  });

  it("does not release when the recording row moved away before promotion", async () => {
    client.catalogEvent.findUnique.mockResolvedValue({
      id: eventId,
      released: false,
    });
    client.catalogEventRecording.findMany.mockResolvedValue([
      { audioHash, isPrimary: false },
    ]);
    client.catalogEventRecording.updateMany.mockResolvedValue({ count: 0 });

    const changed = await ensureSingleRecordingEventState(
      client as unknown as EventStateClient,
      catalogId,
      eventId,
      userId
    );

    expect(changed).toBe(false);
    expect(client.catalogEvent.updateMany).not.toHaveBeenCalled();
  });
});
