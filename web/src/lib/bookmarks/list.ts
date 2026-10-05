import prisma from "@/lib/db";
import { getCatalogCapability } from "@/lib/access/capabilities";
import {
  catalogEventRecordingVisibilityWhere,
  resolveReadableEventIds,
  resolveReadableRecordingHashes,
} from "@/lib/catalog-events/read-service";
import {
  buildCatalogFeaturesResponse,
  getLabsPreferenceForUser,
} from "@/lib/features/capabilities";
import type { CatalogGrant } from "@/lib/policy/catalog-permissions";
import {
  bookmarkSelect,
  serializeBookmark,
  type BookmarkRecording,
  type UserBookmark,
} from "@/lib/bookmarks/schemas";

interface CatalogBookmarkRow {
  workflowGroupId: string;
  audioHash: string;
}

/** The events the user can open whose primary recording is one of `hashes`. */
async function loadPrimaryEvents(
  catalogId: string,
  catalogGrant: CatalogGrant | null,
  hashes: string[],
) {
  const eventIds = await resolveReadableEventIds(catalogId, catalogGrant);
  return prisma.catalogEventRecording.findMany({
    where: {
      workflowGroupId: catalogId,
      audioHash: { in: hashes },
      isPrimary: true,
      ...catalogEventRecordingVisibilityWhere(eventIds),
    },
    select: {
      audioHash: true,
      event: {
        select: {
          id: true,
          dateYear: true,
          dateMonth: true,
          dateDay: true,
          location: { select: { name: true } },
        },
      },
    },
  });
}

/** What the recording page heading is made of, per hash. */
async function loadRecordingHeadings(catalogId: string, hashes: string[]) {
  const [entries, metadata] = await Promise.all([
    prisma.catalogEntry.findMany({
      where: { workflowGroupId: catalogId, audioHash: { in: hashes } },
      select: { audioHash: true, sourceTitle: true, filename: true },
    }),
    prisma.audioMetadata.findMany({
      where: { workflowGroupId: catalogId, audioHash: { in: hashes } },
      select: {
        audioHash: true,
        title: true,
        dateYear: true,
        dateMonth: true,
        dateDay: true,
        location: { select: { name: true } },
      },
    }),
  ]);
  return {
    entryByHash: new Map(entries.map((row) => [row.audioHash, row])),
    metadataByHash: new Map(metadata.map((row) => [row.audioHash, row])),
  };
}

/**
 * The recordings in one catalog that the user can still open, keyed by hash,
 * with what the bookmarks page shows of each. Access is checked here rather
 * than when the bookmark was made: a revoked grant or an unpublished recording
 * hides its bookmarks, and they come back with the access.
 */
async function loadReadableRecordings(
  userId: string,
  catalogId: string,
  catalogLabel: string | null,
  hashes: string[],
  labsEnabled: boolean,
): Promise<Map<string, BookmarkRecording>> {
  const capability = await getCatalogCapability(catalogId, userId);
  if (!capability.catalogExists || !capability.canViewCatalog) return new Map();

  const readable = [
    ...(await resolveReadableRecordingHashes(catalogId, capability.catalogGrant, hashes)),
  ];
  if (readable.length === 0) return new Map();

  const features = buildCatalogFeaturesResponse(
    capability.catalogGrant,
    labsEnabled,
    capability.isCatalogAdmin,
    { catalogExists: capability.catalogExists, canEnterPortal: capability.canEnterPortal },
  ).features;
  const [{ entryByHash, metadataByHash }, primaryAssignments] = await Promise.all([
    loadRecordingHeadings(catalogId, readable),
    features.events.canView
      ? loadPrimaryEvents(catalogId, capability.catalogGrant, readable)
      : Promise.resolve([]),
  ]);
  const eventByHash = new Map(primaryAssignments.map((row) => [row.audioHash, row.event]));

  // The same heading the page shows: the curated title, with the event's date
  // and place when it opens on the event, else the recording's own.
  return new Map(
    readable.map((audioHash) => {
      const entry = entryByHash.get(audioHash);
      const metadata = metadataByHash.get(audioHash);
      const event = eventByHash.get(audioHash);
      const when = event ?? metadata;
      const recording: BookmarkRecording = {
        catalogId,
        catalogLabel,
        audioHash,
        title: metadata?.title?.trim() || null,
        fallbackTitle: entry?.sourceTitle?.trim() || entry?.filename || null,
        dateYear: when?.dateYear ?? null,
        dateMonth: when?.dateMonth ?? null,
        dateDay: when?.dateDay ?? null,
        locationName: (event ? event.location.name : metadata?.location?.name) ?? null,
        eventId: event?.id ?? null,
      };
      return [audioHash, recording];
    }),
  );
}

/** All of a user's bookmarks they can still open, newest first. */
export async function listUserBookmarks(userId: string): Promise<UserBookmark[]> {
  const rows = await prisma.recordingBookmark.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      ...bookmarkSelect,
      workflowGroupId: true,
      audioHash: true,
      workflowGroup: { select: { label: true } },
    },
  });
  if (rows.length === 0) return [];

  const catalogs = new Map<string, { label: string | null; rows: CatalogBookmarkRow[] }>();
  for (const row of rows) {
    const catalog = catalogs.get(row.workflowGroupId) ?? {
      label: row.workflowGroup.label,
      rows: [],
    };
    catalog.rows.push(row);
    catalogs.set(row.workflowGroupId, catalog);
  }

  const { enabled: labsEnabled } = await getLabsPreferenceForUser(userId);
  const readableByCatalog = new Map(
    await Promise.all(
      [...catalogs].map(
        async ([catalogId, catalog]) =>
          [
            catalogId,
            await loadReadableRecordings(
              userId,
              catalogId,
              catalog.label,
              [...new Set(catalog.rows.map((row) => row.audioHash))],
              labsEnabled,
            ),
          ] as const,
      ),
    ),
  );

  return rows.flatMap((row) => {
    const recording = readableByCatalog.get(row.workflowGroupId)?.get(row.audioHash);
    return recording ? [{ ...serializeBookmark(row), recording }] : [];
  });
}
