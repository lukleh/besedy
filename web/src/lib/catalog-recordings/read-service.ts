import prisma from '@/lib/db';
import { projectRecordingMetadata, resolveRecordingMetadata } from './metadata';
export { resolveCatalogRecordingTitle } from './metadata';

export interface CatalogRecordingReadModel {
  audioHash: string;
  catalogEntryExists: boolean;
  title: string;
  artist: string | null;
  album: { id: number | null; name: string } | null;
  durationHms: string | null;
  sourceDate: string | null;
  date: {
    year: number | null;
    month: number | null;
    day: number | null;
  };
  location: { id: number; name: string } | null;
  recorder: { id: number; name: string } | null;
  verified: boolean;
  notes: string | null;
  tags: string[];
  ready: boolean;
  published: boolean;
}

/**
 * Load the canonical read model used beneath both web and MCP serializers.
 * A model is returned for every requested hash so callers preserve the
 * historical hash fallback even when catalog or curated metadata is missing.
 */
export async function loadCatalogRecordingReadModels(
  catalogId: string,
  hashes: string[],
): Promise<Map<string, CatalogRecordingReadModel>> {
  const uniqueHashes = [...new Set(hashes)];
  if (uniqueHashes.length === 0) return new Map();

  const [catalogRows, metadataRows] = await Promise.all([
    prisma.catalogEntry.findMany({
      where: { workflowGroupId: catalogId, audioHash: { in: uniqueHashes } },
      select: {
        audioHash: true,
        durationHms: true,
        sourceTitle: true,
        sourceArtist: true,
        sourceAlbum: true,
        sourceDate: true,
        isActionable: true,
        isPublished: true,
      },
    }),
    prisma.audioMetadata.findMany({
      where: { workflowGroupId: catalogId, audioHash: { in: uniqueHashes } },
      select: {
        audioHash: true,
        title: true,
        artist: true,
        verified: true,
        dateYear: true,
        dateMonth: true,
        dateDay: true,
        notes: true,
        tags: true,
        album: { select: { id: true, name: true } },
        recorder: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
      },
    }),
  ]);

  const catalogByHash = new Map(catalogRows.map((row) => [row.audioHash, row]));
  const metadataByHash = new Map(
    metadataRows.map((row) => [row.audioHash, row]),
  );

  return new Map(
    uniqueHashes.map((audioHash) => {
      const catalog = catalogByHash.get(audioHash);
      const curated = projectRecordingMetadata(metadataByHash.get(audioHash));
      const display = resolveRecordingMetadata({
        hash: audioHash, title: catalog?.sourceTitle, artist: catalog?.sourceArtist, ...curated,
      });
      const model: CatalogRecordingReadModel = {
        audioHash,
        catalogEntryExists: catalog !== undefined,
        title: display.title ?? audioHash,
        artist: display.artist,
        album:
          curated.album ??
          (catalog?.sourceAlbum
            ? { id: null, name: catalog.sourceAlbum }
            : null),
        durationHms: catalog?.durationHms ?? null,
        sourceDate: catalog?.sourceDate ?? null,
        date: {
          year: curated.dateYear ?? null,
          month: curated.dateMonth ?? null,
          day: curated.dateDay ?? null,
        },
        location: curated.location,
        recorder: curated.recorder,
        verified: curated.verified,
        notes: curated.notes,
        tags: curated.tags,
        ready: catalog?.isActionable ?? false,
        published: catalog?.isPublished ?? false,
      };
      return [audioHash, model];
    }),
  );
}
