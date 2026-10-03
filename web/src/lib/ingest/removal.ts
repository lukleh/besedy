import { replaceLostPrimaryRecording } from '@/lib/catalog-events/primary-succession';
import prisma from '@/lib/db';

export interface RecordingWebStateRemoval {
  detachedEventId: number | null;
  promotedAudioHash: string | null;
  unreleasedEventId: number | null;
  metadataDeleted: number;
  progressDeleted: number;
  progressRetained: boolean;
  notificationsDeleted: number;
  bookmarksDeleted: number;
}

/**
 * Delete everything the web app itself owns about one recording after the host
 * worker removed it from the catalog: event assignment (promoting the event's
 * next playable recording when this one was primary, or unreleasing the event
 * when none is left, so listeners never see an event without audio), curated
 * metadata, playback progress, notifications and listeners' bookmarks. The projection
 * tables are rebuilt by the following catalog sync.
 */
export async function removeRecordingWebState(
  catalogId: string,
  audioHash: string,
): Promise<RecordingWebStateRemoval> {
  return prisma.$transaction(async (tx) => {
    let detachedEventId: number | null = null;
    let promotedAudioHash: string | null = null;
    let unreleasedEventId: number | null = null;

    const assignment = await tx.catalogEventRecording.findUnique({
      where: {
        workflowGroupId_audioHash: { workflowGroupId: catalogId, audioHash },
      },
      select: { eventId: true },
    });
    if (assignment) {
      // Serialize with release/detach operations on the same event row.
      await tx.$queryRaw`
        SELECT id
        FROM catalog_event
        WHERE id = ${assignment.eventId}
        FOR UPDATE
      `;
      // Read the primary flag from the deleted row, after the lock is held.
      const detached = await tx.catalogEventRecording.delete({
        where: {
          workflowGroupId_audioHash: { workflowGroupId: catalogId, audioHash },
        },
        select: { isPrimary: true },
      });
      detachedEventId = assignment.eventId;
      if (detached.isPrimary) {
        const outcome = await replaceLostPrimaryRecording(
          tx,
          catalogId,
          assignment.eventId,
        );
        if (outcome.kind === 'promoted') promotedAudioHash = outcome.audioHash;
        if (outcome.kind === 'unreleased') unreleasedEventId = assignment.eventId;
      }
    }

    const metadata = await tx.audioMetadata.deleteMany({
      where: { workflowGroupId: catalogId, audioHash },
    });
    const remainingCatalogRefs = await tx.catalogEntry.count({
      where: { audioHash, workflowGroupId: { not: catalogId } },
    });
    const progress =
      remainingCatalogRefs === 0
        ? await tx.recordingPlaybackProgress.deleteMany({
            where: { audioHash },
          })
        : { count: 0 };
    const notifications = await tx.recordingNotification.deleteMany({
      where: { catalogId, audioHash },
    });
    const bookmarks = await tx.recordingBookmark.deleteMany({
      where: { workflowGroupId: catalogId, audioHash },
    });

    await tx.workflowGroup.update({
      where: { id: catalogId },
      data: { updatedAt: new Date() },
    });

    return {
      detachedEventId,
      promotedAudioHash,
      unreleasedEventId,
      metadataDeleted: metadata.count,
      progressDeleted: progress.count,
      progressRetained: remainingCatalogRefs > 0,
      notificationsDeleted: notifications.count,
      bookmarksDeleted: bookmarks.count,
    };
  });
}
