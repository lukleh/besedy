import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCatalogEntryFindMany = vi.fn();
const mockAudioMetadataFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  default: {
    catalogEntry: {
      findMany: mockCatalogEntryFindMany,
    },
    audioMetadata: {
      findMany: mockAudioMetadataFindMany,
    },
  },
}));

describe("loadEnrichedCatalogEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses catalog_entry duplicateCount values without loading duplicates rows", async () => {
    const { loadEnrichedCatalogEntries } = await import("@/lib/catalog");

    mockCatalogEntryFindMany.mockResolvedValue([
      {
        audioHash: "b".repeat(64),
        compressedPath: "/archive/b.webm",
        filename: "b.wav",
        originalPath: "/source/b.wav",
        scanRoot: "/source",
        durationHms: "00:10:00",
        sourceTitle: "Bravo",
        sourceArtist: "Source Artist",
        sourceAlbum: "Source Album",
        sourceDate: "2024-05-10",
        hasArchived: true,
        hasMetadata: true,
        isActionable: true,
        isPublished: true,
        duplicateCount: 4,
      },
    ]);
    mockAudioMetadataFindMany.mockResolvedValue([
      {
        audioHash: "b".repeat(64),
        title: "Curated Title",
        artist: "Curated Artist",
        dateYear: 2024,
        dateMonth: 5,
        dateDay: 10,
        verified: true,
        verifiedAt: new Date("2024-05-11T00:00:00.000Z"),
        tags: ["tag-1"],
        notes: "note",
        recorderId: 1,
        recorder: { id: 1, name: "Recorder" },
        locationId: 2,
        location: { id: 2, name: "Location" },
        albumId: 3,
        album: { id: 3, name: "Album" },
        part: 7,
      },
    ]);

    const entries = await loadEnrichedCatalogEntries("catalog-1");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      hash: "b".repeat(64),
      duplicateCount: 4,
      curatedTitle: "Curated Title",
      curatedArtist: "Curated Artist",
      verified: true,
      recorder: { id: 1, name: "Recorder" },
      location: { id: 2, name: "Location" },
      album: { id: 3, name: "Album" },
      part: 7,
    });
    expect(mockCatalogEntryFindMany).toHaveBeenCalledTimes(1);
    expect(mockAudioMetadataFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workflowGroupId: "catalog-1",
          audioHash: { in: ["b".repeat(64)] },
        },
      }),
    );
  });
});
