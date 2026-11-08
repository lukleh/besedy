import type { AudioMetadata } from '@/generated/prisma/client';
import type { CatalogEntry, EnrichedCatalogEntry } from '@/lib/catalog-types';

interface NamedMetadata { id: number; name: string }
type CuratedMetadata = Partial<AudioMetadata> & {
  album?: NamedMetadata | null;
  recorder?: NamedMetadata | null;
  location?: NamedMetadata | null;
};
type MetadataProjection = Omit<EnrichedCatalogEntry, keyof CatalogEntry | 'duplicateCount'>;

function namedMetadata(value: NamedMetadata | null | undefined): NamedMetadata | null {
  return value ? { id: value.id, name: value.name } : null;
}

/** The curated portion shared by recording, catalog, event and MCP readers. */
export function projectRecordingMetadata(metadata: CuratedMetadata | null | undefined): MetadataProjection {
  return {
    curated: metadata != null,
    curatedTitle: metadata?.title,
    curatedArtist: metadata?.artist,
    dateYear: metadata?.dateYear ?? null,
    dateMonth: metadata?.dateMonth ?? null,
    dateDay: metadata?.dateDay ?? null,
    verified: metadata?.verified ?? false,
    verifiedAt: metadata?.verifiedAt?.toISOString() ?? null,
    tags: metadata?.tags ?? [],
    notes: metadata?.notes ?? null,
    recorderId: metadata?.recorderId ?? metadata?.recorder?.id ?? null,
    recorder: namedMetadata(metadata?.recorder),
    locationId: metadata?.locationId ?? metadata?.location?.id ?? null,
    location: namedMetadata(metadata?.location),
    albumId: metadata?.albumId ?? metadata?.album?.id ?? null,
    album: namedMetadata(metadata?.album),
    part: metadata?.part ?? null,
  };
}

interface RecordingDisplaySources {
  hash: string;
  title?: string | null;
  artist?: string | null;
  curatedTitle?: string | null;
  curatedArtist?: string | null;
}

/** Null means fall back to source data; an explicitly empty correction is kept. */
export function resolveRecordingDisplay(entry: RecordingDisplaySources) {
  return {
    title: entry.curatedTitle ?? entry.title ?? entry.hash,
    artist: entry.curatedArtist ?? entry.artist ?? null,
  };
}

export function resolveCatalogRecordingTitle(
  audioHash: string,
  sources: { curatedTitle?: string | null; sourceTitle?: string | null },
): string {
  return resolveRecordingDisplay({ hash: audioHash, title: sources.sourceTitle,
    curatedTitle: sources.curatedTitle }).title;
}
