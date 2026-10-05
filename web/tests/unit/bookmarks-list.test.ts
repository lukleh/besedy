import { beforeEach, describe, expect, it, vi } from "vitest";
import { listUserBookmarks } from "@/lib/bookmarks/list";
import { buildBookmarkHref } from "@/lib/bookmarks/schemas";

const mocks = vi.hoisted(() => ({
  bookmarkFindMany: vi.fn(),
  eventRecordingFindMany: vi.fn(),
  catalogEntryFindMany: vi.fn(),
  audioMetadataFindMany: vi.fn(),
  getCatalogCapability: vi.fn(),
  resolveReadableRecordingHashes: vi.fn(),
  resolveReadableEventIds: vi.fn(),
  buildCatalogFeaturesResponse: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    recordingBookmark: { findMany: mocks.bookmarkFindMany },
    catalogEventRecording: { findMany: mocks.eventRecordingFindMany },
    catalogEntry: { findMany: mocks.catalogEntryFindMany },
    audioMetadata: { findMany: mocks.audioMetadataFindMany },
  },
}));
vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: mocks.getCatalogCapability,
}));
vi.mock("@/lib/catalog-events/read-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/catalog-events/read-service")>()),
  resolveReadableRecordingHashes: mocks.resolveReadableRecordingHashes,
  resolveReadableEventIds: mocks.resolveReadableEventIds,
}));
vi.mock("@/lib/features/capabilities", () => ({
  getLabsPreferenceForUser: vi.fn().mockResolvedValue({ enabled: false }),
  buildCatalogFeaturesResponse: mocks.buildCatalogFeaturesResponse,
}));

const CATALOG = "20260101_120000";
const REVOKED_CATALOG = "20250101_120000";
const EVENT_HASH = "a".repeat(64);
const PLAIN_HASH = "b".repeat(64);
const UNPUBLISHED_HASH = "c".repeat(64);
const DATE = new Date("2026-10-03T12:00:00Z");

function row(id: string, workflowGroupId: string, audioHash: string, positionSec: number) {
  return {
    id,
    workflowGroupId,
    audioHash,
    positionSec,
    comment: `comment ${id}`,
    excerpt: null,
    createdAt: DATE,
    updatedAt: DATE,
    workflowGroup: { label: `label ${workflowGroupId}` },
  };
}


describe("listUserBookmarks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookmarkFindMany.mockResolvedValue([
      row("b1", CATALOG, EVENT_HASH, 10),
      row("b2", CATALOG, PLAIN_HASH, 20),
      row("b3", CATALOG, UNPUBLISHED_HASH, 30),
      row("b4", REVOKED_CATALOG, EVENT_HASH, 40),
    ]);
    mocks.getCatalogCapability.mockImplementation(async (catalogId: string) => ({
      catalogExists: true,
      canViewCatalog: catalogId === CATALOG,
      catalogGrant: { role: "listener" },
      isCatalogAdmin: false,
      canEnterPortal: true,
    }));
    mocks.resolveReadableRecordingHashes.mockResolvedValue(new Set([EVENT_HASH, PLAIN_HASH]));
    mocks.resolveReadableEventIds.mockResolvedValue([7]);
    mocks.catalogEntryFindMany.mockResolvedValue([
      { audioHash: EVENT_HASH, sourceTitle: "2004-05-12 rec", filename: "a.wav" },
      { audioHash: PLAIN_HASH, sourceTitle: null, filename: "b.wav" },
    ]);
    // Only the event recording has curated metadata.
    mocks.audioMetadataFindMany.mockResolvedValue([
      {
        audioHash: EVENT_HASH,
        title: "Curated title",
        dateYear: 2004,
        dateMonth: 5,
        dateDay: 12,
        location: { name: "Praha" },
      },
    ]);
    mocks.buildCatalogFeaturesResponse.mockReturnValue({ features: { events: { canView: true } } });
    mocks.eventRecordingFindMany.mockResolvedValue([
      {
        audioHash: EVENT_HASH,
        event: {
          id: 7,
          dateYear: 2004,
          dateMonth: 5,
          dateDay: null,
          location: { name: "Brno" },
        },
      },
    ]);
  });

  it("lists only bookmarks in recordings the user can still open", async () => {
    const bookmarks = await listUserBookmarks("user-1");

    expect(bookmarks.map((bookmark) => bookmark.id)).toEqual(["b1", "b2"]);
    expect(mocks.bookmarkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" }, orderBy: { createdAt: "desc" } }),
    );
    expect(mocks.resolveReadableRecordingHashes).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReadableRecordingHashes).toHaveBeenCalledWith(
      CATALOG,
      { role: "listener" },
      [EVENT_HASH, PLAIN_HASH, UNPUBLISHED_HASH],
    );
  });

  it("opens a primary recording on its event, headed like the event page", async () => {
    const [eventBookmark, plainBookmark] = await listUserBookmarks("user-1");

    expect(eventBookmark.recording).toEqual({
      catalogId: CATALOG,
      catalogLabel: `label ${CATALOG}`,
      audioHash: EVENT_HASH,
      title: "Curated title",
      fallbackTitle: "2004-05-12 rec",
      dateYear: 2004,
      dateMonth: 5,
      dateDay: null,
      locationName: "Brno",
      eventId: 7,
    });
    expect(buildBookmarkHref(eventBookmark.recording, 10.9)).toBe(
      `/catalog/${CATALOG}/event/7?seek=10`,
    );
    expect(mocks.eventRecordingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workflowGroupId: CATALOG,
          audioHash: { in: [EVENT_HASH, PLAIN_HASH] },
          isPrimary: true,
          eventId: { in: [7] },
        },
      }),
    );

    expect(plainBookmark.recording).toMatchObject({
      title: null,
      fallbackTitle: "b.wav",
      dateYear: null,
      locationName: null,
      eventId: null,
    });
    expect(buildBookmarkHref(plainBookmark.recording, 20)).toBe(
      `/catalog/${CATALOG}/recording/${PLAIN_HASH}?seek=20`,
    );
  });

  it("opens recordings directly when the user has no events view", async () => {
    mocks.buildCatalogFeaturesResponse.mockReturnValue({ features: { events: { canView: false } } });

    const bookmarks = await listUserBookmarks("user-1");

    expect(bookmarks.map((bookmark) => bookmark.recording.eventId)).toEqual([null, null]);
    // Without the event, the date and place are the recording's own.
    expect(bookmarks[0].recording).toMatchObject({ dateDay: 12, locationName: "Praha" });
    expect(mocks.eventRecordingFindMany).not.toHaveBeenCalled();
  });
});
