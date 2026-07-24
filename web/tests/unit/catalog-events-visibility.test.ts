import { describe, expect, it, vi } from "vitest";
import {
  getPublishedAccessibleRecordingHashes,
  getPublishedVisibleEventIds,
  isPublishedVisibleEvent,
} from "@/lib/catalog-events/visibility";

describe("catalog event visibility helpers", () => {
  it("filters event ids through the listener-visible event policy", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          eventId: 1,
          released: true,
          primaryRecordingActionable: true,
          primaryRecordingPublished: true,
        },
        {
          eventId: 2,
          released: true,
          primaryRecordingActionable: true,
          primaryRecordingPublished: false,
        },
        {
          eventId: 3,
          released: true,
          primaryRecordingActionable: null,
          primaryRecordingPublished: null,
        },
      ]),
      catalogEntry: {
        findMany: vi.fn(),
      },
    };

    const result = await getPublishedVisibleEventIds(prisma as never, "catalog-1");

    expect(result).toEqual([1]);
  });

  it("treats only released events with a published actionable primary as visible", async () => {
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([
          {
            eventId: 7,
            released: false,
            primaryRecordingActionable: true,
            primaryRecordingPublished: true,
          },
        ])
        .mockResolvedValueOnce([
          {
            eventId: 8,
            released: true,
            primaryRecordingActionable: true,
            primaryRecordingPublished: true,
          },
        ]),
      catalogEntry: {
        findMany: vi.fn(),
      },
    };

    await expect(isPublishedVisibleEvent(prisma as never, "catalog-1", 7)).resolves.toBe(
      false
    );
    await expect(isPublishedVisibleEvent(prisma as never, "catalog-1", 8)).resolves.toBe(
      true
    );
  });

  it("treats an event as visible when any primary row is listener-visible", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          eventId: 9,
          released: true,
          primaryRecordingActionable: true,
          primaryRecordingPublished: false,
        },
        {
          eventId: 9,
          released: true,
          primaryRecordingActionable: true,
          primaryRecordingPublished: true,
        },
      ]),
      catalogEntry: {
        findMany: vi.fn(),
      },
    };

    await expect(isPublishedVisibleEvent(prisma as never, "catalog-1", 9)).resolves.toBe(
      true
    );
  });

  it("filters listener-accessible recording hashes through recording visibility policy", async () => {
    const prisma = {
      $queryRaw: vi.fn(),
      catalogEntry: {
        findMany: vi.fn().mockResolvedValue([
          {
            audioHash: "a".repeat(64),
            isActionable: true,
            isPublished: true,
          },
          {
            audioHash: "b".repeat(64),
            isActionable: true,
            isPublished: false,
          },
          {
            audioHash: "c".repeat(64),
            isActionable: false,
            isPublished: true,
          },
        ]),
      },
    };

    const result = await getPublishedAccessibleRecordingHashes(prisma as never, "catalog-1", [
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
    ]);

    expect(result).toEqual(new Set(["a".repeat(64)]));
  });

  it("returns an empty set without querying when no hashes are requested", async () => {
    const prisma = {
      $queryRaw: vi.fn(),
      catalogEntry: {
        findMany: vi.fn(),
      },
    };

    const result = await getPublishedAccessibleRecordingHashes(prisma as never, "catalog-1", []);

    expect(result).toEqual(new Set());
    expect(prisma.catalogEntry.findMany).not.toHaveBeenCalled();
  });
});
