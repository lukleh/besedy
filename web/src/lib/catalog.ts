import prisma from "@/lib/db";
import {
  mapArchivedPayloadToFullArchived,
  mapCatalogEntryRowToCatalogEntry,
  mapDuplicatePayloadToDuplicateEntry,
  mapMetadataPayloadToFullMetadata,
} from "./catalog-payloads";
import type {
  CatalogEntry,
  DuplicateEntry,
  EnrichedCatalogEntry,
  FullRecordingDetails,
} from "./catalog-types";

// Shared catalog/data-access helpers used by the web app. This module owns CSV
// row shapes plus the DB-backed lookup/derivation helpers that sit underneath
// route handlers and page loaders.

export * from "./catalog-types";
export {
  buildArchivedPayloadFromRaw,
  buildDuplicatePayloadFromRaw,
  buildMetadataPayloadFromRaw,
} from "./catalog-payloads";
export {
  applyFilters,
  compareNumbers,
  compareNumbersNullFirst,
  compareStrings,
  extractDateParts,
  formatDuration,
  isCatalogEntryReady,
  parseDuration,
  scopeCatalogEntriesForAccess,
} from "./catalog-filters";
export { parseDateFromString } from "./date-utils";

function compareCatalogEntryTitles(a: CatalogEntry, b: CatalogEntry): number {
  const aTitle = a.title || a.filename || a.hash;
  const bTitle = b.title || b.filename || b.hash;
  return aTitle.localeCompare(bTitle);
}

export async function getCatalogEntry(
  groupId: string,
  hash: string,
): Promise<CatalogEntry | undefined> {
  const row = await prisma.catalogEntry.findUnique({
    where: {
      workflowGroupId_audioHash: {
        workflowGroupId: groupId,
        audioHash: hash,
      },
    },
    select: {
      audioHash: true,
      compressedPath: true,
      filename: true,
      originalPath: true,
      scanRoot: true,
      durationHms: true,
      sourceTitle: true,
      sourceArtist: true,
      sourceAlbum: true,
      sourceDate: true,
      hasArchived: true,
      hasMetadata: true,
      isActionable: true,
      isPublished: true,
    },
  });
  if (!row) return undefined;
  return mapCatalogEntryRowToCatalogEntry(row);
}

/**
 * Fetch catalog entries for a specific set of audio hashes. Lets callers (e.g.
 * radio mode) load only the entries they need — such as the event primary
 * recordings — instead of the whole catalog. Returned in no particular order.
 */
export async function getCatalogEntriesByHashes(
  groupId: string,
  hashes: string[],
): Promise<CatalogEntry[]> {
  if (hashes.length === 0) {
    return [];
  }
  const rows = await prisma.catalogEntry.findMany({
    where: { workflowGroupId: groupId, audioHash: { in: hashes } },
    select: {
      audioHash: true,
      compressedPath: true,
      filename: true,
      originalPath: true,
      scanRoot: true,
      durationHms: true,
      sourceTitle: true,
      sourceArtist: true,
      sourceAlbum: true,
      sourceDate: true,
      hasArchived: true,
      hasMetadata: true,
      isActionable: true,
      isPublished: true,
    },
  });
  return rows.map(mapCatalogEntryRowToCatalogEntry);
}

export async function loadCatalogHashes(groupId: string): Promise<Set<string>> {
  const rows = await prisma.catalogEntry.findMany({
    where: { workflowGroupId: groupId },
    select: { audioHash: true },
  });
  return new Set(rows.map((row) => row.audioHash));
}

export async function loadDuplicates(groupId: string): Promise<Map<string, DuplicateEntry[]>> {
  const rows = await prisma.catalogDuplicate.findMany({
    where: { workflowGroupId: groupId },
    select: {
      audioHash: true,
      originalPath: true,
      duplicatePath: true,
      duplicatePayload: true,
    },
  });

  const byHash = new Map<string, DuplicateEntry[]>();
  for (const row of rows) {
    const entry = mapDuplicatePayloadToDuplicateEntry(
      row.audioHash,
      row.originalPath,
      row.duplicatePath,
      row.duplicatePayload,
    );
    const existing = byHash.get(row.audioHash) || [];
    existing.push(entry);
    byHash.set(row.audioHash, existing);
  }
  return byHash;
}

export async function countDuplicatesByHash(groupId: string): Promise<Map<string, number>> {
  const duplicates = await loadDuplicates(groupId);
  const counts = new Map<string, number>();
  for (const [hash, entries] of duplicates) {
    counts.set(hash, entries.length);
  }
  return counts;
}

export async function getDistinctDuplicateCounts(groupId: string): Promise<number[]> {
  const rows = await prisma.catalogEntry.findMany({
    where: { workflowGroupId: groupId },
    select: { duplicateCount: true },
    distinct: ["duplicateCount"],
  });
  const uniqueCounts = new Set<number>();
  uniqueCounts.add(0);
  for (const row of rows) {
    uniqueCounts.add(row.duplicateCount);
  }
  return Array.from(uniqueCounts).sort((a, b) => a - b);
}

export async function getDistinctArtists(groupId: string): Promise<string[]> {
  const rows = await prisma.catalogEntry.groupBy({
    by: ["sourceArtist"],
    where: {
      workflowGroupId: groupId,
      hasMetadata: true,
      sourceArtist: { not: null },
    },
  });

  const artists = Array.from(
    new Set(
      rows
        .map((row) => row.sourceArtist?.trim())
        .filter((artist): artist is string => !!artist),
    ),
  );
  artists.sort((a, b) => a.localeCompare(b));
  return artists;
}

export async function getDistinctAlbums(groupId: string): Promise<string[]> {
  const rows = await prisma.catalogEntry.groupBy({
    by: ["sourceAlbum"],
    where: {
      workflowGroupId: groupId,
      hasMetadata: true,
      sourceAlbum: { not: null },
    },
  });

  const albums = Array.from(
    new Set(
      rows
        .map((row) => row.sourceAlbum?.trim())
        .filter((album): album is string => !!album),
    ),
  );
  albums.sort((a, b) => a.localeCompare(b));
  return albums;
}

export async function getFullCatalogEntry(
  groupId: string,
  hash: string,
): Promise<FullRecordingDetails | null> {
  const [entryRow, duplicateRows] = await Promise.all([
    prisma.catalogEntry.findUnique({
      where: {
        workflowGroupId_audioHash: {
          workflowGroupId: groupId,
          audioHash: hash,
        },
      },
      select: {
        audioHash: true,
        compressedPath: true,
        filename: true,
        originalPath: true,
        scanRoot: true,
        durationHms: true,
        sourceTitle: true,
        sourceArtist: true,
        sourceAlbum: true,
        sourceDate: true,
        hasArchived: true,
        hasMetadata: true,
        isActionable: true,
        isPublished: true,
        sourceMetadataPayload: true,
        sourceArchivedPayload: true,
      },
    }),
    prisma.catalogDuplicate.findMany({
      where: { workflowGroupId: groupId, audioHash: hash },
      select: {
        audioHash: true,
        originalPath: true,
        duplicatePath: true,
        duplicatePayload: true,
      },
      orderBy: { duplicatePath: "asc" },
    }),
  ]);

  if (!entryRow) return null;

  return {
    entry: mapCatalogEntryRowToCatalogEntry(entryRow),
    fullMetadata: mapMetadataPayloadToFullMetadata(hash, entryRow.sourceMetadataPayload),
    fullArchived: mapArchivedPayloadToFullArchived(hash, entryRow.sourceArchivedPayload),
    duplicates: duplicateRows.map((row) =>
      mapDuplicatePayloadToDuplicateEntry(
        row.audioHash,
        row.originalPath,
        row.duplicatePath,
        row.duplicatePayload,
      ),
    ),
  };
}

export async function loadEnrichedCatalogEntries(
  groupId: string,
): Promise<EnrichedCatalogEntry[]> {
  const entryRows = await prisma.catalogEntry.findMany({
    where: { workflowGroupId: groupId },
    select: {
      audioHash: true,
      compressedPath: true,
      filename: true,
      originalPath: true,
      scanRoot: true,
      durationHms: true,
      sourceTitle: true,
      sourceArtist: true,
      sourceAlbum: true,
      sourceDate: true,
      hasArchived: true,
      hasMetadata: true,
      isActionable: true,
      isPublished: true,
      duplicateCount: true,
    },
  });
  const hashes = entryRows.map((row) => row.audioHash);
  const metadataRecords = await prisma.audioMetadata.findMany({
    where: {
      workflowGroupId: groupId,
      audioHash: { in: hashes },
    },
    include: {
      recorder: true,
      location: true,
      album: true,
    },
  });

  const entries = entryRows
    .map((row) => ({
      entry: mapCatalogEntryRowToCatalogEntry(row),
      duplicateCount: row.duplicateCount,
    }))
    .sort((a, b) => compareCatalogEntryTitles(a.entry, b.entry));
  const metadataByHash = new Map(metadataRecords.map((metadata) => [metadata.audioHash, metadata]));

  return entries.map(({ entry, duplicateCount }) => {
    const meta = metadataByHash.get(entry.hash);
    let curatedDate: string | null = null;
    if (meta?.dateYear || meta?.dateMonth || meta?.dateDay) {
      const parts: string[] = [];
      if (meta.dateDay) parts.push(String(meta.dateDay));
      if (meta.dateMonth) parts.push(String(meta.dateMonth));
      if (meta.dateYear) parts.push(String(meta.dateYear));
      curatedDate = parts.join(".");
    }

    return {
      ...entry,
      curated: !!meta,
      curatedTitle: meta?.title,
      curatedArtist: meta?.artist,
      curatedDate,
      dateYear: meta?.dateYear ?? null,
      dateMonth: meta?.dateMonth ?? null,
      dateDay: meta?.dateDay ?? null,
      verified: meta?.verified ?? false,
      verifiedAt: meta?.verifiedAt?.toISOString() ?? null,
      tags: meta?.tags ?? [],
      notes: meta?.notes ?? null,
      recorderId: meta?.recorderId ?? null,
      recorder: meta?.recorder ? { id: meta.recorder.id, name: meta.recorder.name } : null,
      locationId: meta?.locationId ?? null,
      location: meta?.location ? { id: meta.location.id, name: meta.location.name } : null,
      albumId: meta?.albumId ?? null,
      album: meta?.album ? { id: meta.album.id, name: meta.album.name } : null,
      part: meta?.part ?? null,
      duplicateCount,
    };
  });
}
