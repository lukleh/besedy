import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGroupBy = vi.fn();
const mockPrisma = {
  catalogEntry: {
    groupBy: mockGroupBy,
  },
};

vi.mock("@/lib/db", () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

describe("catalog distinct values", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates artists after trimming whitespace", async () => {
    const { getDistinctArtists } = await import("@/lib/catalog");
    mockGroupBy.mockResolvedValue([
      { sourceArtist: " Artist" },
      { sourceArtist: "Artist " },
      { sourceArtist: "Artist" },
      { sourceArtist: "  " },
      { sourceArtist: null },
      { sourceArtist: "Beta" },
    ]);

    const artists = await getDistinctArtists("20251222_144441");

    expect(artists).toEqual(["Artist", "Beta"]);
    expect(mockGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["sourceArtist"],
      })
    );
  });

  it("deduplicates albums after trimming whitespace", async () => {
    const { getDistinctAlbums } = await import("@/lib/catalog");
    mockGroupBy.mockResolvedValue([
      { sourceAlbum: " Album A" },
      { sourceAlbum: "Album A " },
      { sourceAlbum: "Album A" },
      { sourceAlbum: "  " },
      { sourceAlbum: null },
      { sourceAlbum: "Album B" },
    ]);

    const albums = await getDistinctAlbums("20251222_144441");

    expect(albums).toEqual(["Album A", "Album B"]);
    expect(mockGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["sourceAlbum"],
      })
    );
  });
});
