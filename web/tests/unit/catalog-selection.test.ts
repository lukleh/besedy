import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyFilters, extractDateParts } from "@/lib/catalog-filters";
import type { CatalogFilters } from "@/lib/catalog-types";

const mocks = vi.hoisted(() => ({ entries: vi.fn(), metadata: vi.fn() }));
vi.mock("@/lib/db", () => ({
  default: {
    catalogEntry: { findMany: mocks.entries },
    audioMetadata: { findMany: mocks.metadata },
  },
}));

import { loadCatalogSelectionEntries, loadEnrichedCatalogEntries } from "@/lib/catalog";

const entry = (hash: string, overrides = {}) => ({
  audioHash: hash, filename: `${hash}.wav`, durationHms: "00:35:00",
  sourceTitle: `Talk ${hash}`, sourceArtist: "Source Artist", sourceDate: "2024-05-10",
  isActionable: true, isPublished: true, duplicateCount: 0,
  compressedPath: "/archive/audio.webm", originalPath: "/source/audio.wav", scanRoot: "/source",
  sourceAlbum: "Source Album", hasArchived: true, hasMetadata: true,
  ...overrides,
});
const metadata = (hash: string, overrides = {}) => ({
  audioHash: hash, title: "Curated Title", artist: "Curated Artist", dateYear: 2024, dateMonth: 2, dateDay: null,
  verified: true, verifiedAt: new Date(), tags: ["large tag payload"], notes: "large note payload",
  recorderId: 1, recorder: { id: 1, name: "Recorder" }, locationId: null, location: null,
  albumId: null, album: null, part: 2,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entries.mockResolvedValue([
    entry("a"),
    entry("b", { sourceDate: "notes from 2019", sourceArtist: "", isPublished: false, duplicateCount: 3 }),
    entry("c", { sourceDate: "3.4.2020", isActionable: false, durationHms: "invalid" }),
  ]);
  mocks.metadata.mockResolvedValue([
    metadata("a"),
    metadata("b", { artist: "", dateYear: null, dateMonth: 6, part: null, verified: false }),
    metadata("orphan", { part: 99 }),
  ]);
});

describe("catalog selection projection", () => {
  it("omits full details and scopes both reads without enumerating catalog hashes", async () => {
    const selected = await loadCatalogSelectionEntries("catalog-1");

    expect(selected).toHaveLength(3);
    expect(selected[0]).not.toHaveProperty("notes");
    expect(selected[0]).not.toHaveProperty("compressedPath");
    expect(mocks.entries.mock.calls[0][0]).toMatchObject({ where: { workflowGroupId: "catalog-1" } });
    expect(mocks.metadata.mock.calls[0][0]).toMatchObject({ where: { workflowGroupId: "catalog-1" } });
    for (const field of ["compressedPath", "originalPath", "scanRoot", "sourceMetadataPayload", "sourceArchivedPayload"]) {
      expect(mocks.entries.mock.calls[0][0].select).not.toHaveProperty(field);
    }
    for (const field of ["notes", "tags", "title", "verifiedAt", "createdAt", "updatedAt"]) {
      expect(mocks.metadata.mock.calls[0][0].select).not.toHaveProperty(field);
    }
  });

  it.each<CatalogFilters>([
    {}, { status: "ready" }, { status: "incomplete" }, { actionableOnly: true },
    { verified: true }, { verified: false }, { artist: "curated" }, { artist: "__empty__" },
    { album: -1 }, { recorder: 1 }, { location: -1 }, { part: 2 }, { part: -1 },
    { dateYear: 2024, dateMonth: 2 }, { dateYear: -1 }, { dateYear: 2020, dateMonth: 4, dateDay: 3 },
    { duration: "medium" }, { duration: "long" }, { duplicates: 3 },
  ])("preserves existing filter and date semantics for %j", async (filters) => {
    const selected = await loadCatalogSelectionEntries("catalog-1");
    const enriched = await loadEnrichedCatalogEntries("catalog-1");

    expect(applyFilters(selected, filters).map((row) => row.hash)).toEqual(
      applyFilters(enriched, filters).map((row) => row.hash),
    );
    expect(selected.map(extractDateParts)).toEqual(enriched.map(extractDateParts));
  });
});
