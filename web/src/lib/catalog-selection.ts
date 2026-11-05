import prisma from "@/lib/db";
import type { CatalogSelectionEntry } from "./catalog-types";

/**
 * Keep selection separate from page enrichment: filtering and locale-aware
 * ordering still run in JavaScript, but never load notes, tags, source payloads
 * or filesystem paths for recordings outside the requested page.
 */
export async function loadCatalogSelectionEntries(groupId: string): Promise<CatalogSelectionEntry[]> {
  const [entries, metadata] = await Promise.all([
    prisma.catalogEntry.findMany({
      where: { workflowGroupId: groupId },
      select: {
        audioHash: true,
        filename: true,
        durationHms: true,
        sourceTitle: true,
        sourceArtist: true,
        sourceDate: true,
        isActionable: true,
        isPublished: true,
        duplicateCount: true,
      },
    }),
    prisma.audioMetadata.findMany({
      where: { workflowGroupId: groupId },
      select: {
        audioHash: true,
        artist: true,
        dateYear: true,
        dateMonth: true,
        dateDay: true,
        verified: true,
        recorderId: true,
        recorder: { select: { id: true, name: true } },
        locationId: true,
        location: { select: { id: true, name: true } },
        albumId: true,
        album: { select: { id: true, name: true } },
        part: true,
      },
    }),
  ]);
  const metadataByHash = new Map(metadata.map((row) => [row.audioHash, row]));
  return entries.map((entry) => {
    const meta = metadataByHash.get(entry.audioHash);
    return {
      hash: entry.audioHash,
      filename: entry.filename ?? undefined,
      duration: entry.durationHms ?? undefined,
      title: entry.sourceTitle ?? undefined,
      artist: entry.sourceArtist ?? undefined,
      date: entry.sourceDate ?? undefined,
      isActionable: entry.isActionable,
      isPublished: entry.isPublished,
      duplicateCount: entry.duplicateCount,
      curatedArtist: meta?.artist,
      dateYear: meta?.dateYear ?? null,
      dateMonth: meta?.dateMonth ?? null,
      dateDay: meta?.dateDay ?? null,
      verified: meta?.verified ?? false,
      recorderId: meta?.recorderId ?? null,
      recorder: meta?.recorder ?? null,
      locationId: meta?.locationId ?? null,
      location: meta?.location ?? null,
      albumId: meta?.albumId ?? null,
      album: meta?.album ?? null,
      part: meta?.part ?? null,
    };
  });
}
