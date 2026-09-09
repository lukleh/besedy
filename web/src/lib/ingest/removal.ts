import prisma from "@/lib/db";

export interface RecordingWebStateRemoval {
  detachedEventId: number | null;
  unreleasedEventId: number | null;
  metadataDeleted: number;
  progressDeleted: number;
  notificationsDeleted: number;
}

/**
 * Delete everything the web app itself owns about one recording after the host
 * worker removed it from the catalog: event assignment (unreleasing an event
 * that loses its primary recording so listeners never see an event without
 * audio), curated metadata, playback progress and notifications. The projection
 * tables are rebuilt by the following catalog sync.
 */
export async function removeRecordingWebState(
  catalogId: string,
  audioHash: string
): Promise<RecordingWebStateRemoval> {
  return prisma.$transaction(async (tx) => {
    let detachedEventId: number | null = null;
    let unreleasedEventId: number | null = null;

    const assignment = await tx.catalogEventRecording.findUnique({
      where: { workflowGroupId_audioHash: { workflowGroupId: catalogId, audioHash } },
      select: { eventId: true, isPrimary: true, event: { select: { released: true } } },
    });
    if (assignment) {
      // Serialize with release/detach operations on the same event row.
      await tx.$queryRaw`
        SELECT id
        FROM catalog_event
        WHERE id = ${assignment.eventId}
        FOR UPDATE
      `;
      await tx.catalogEventRecording.delete({
        where: { workflowGroupId_audioHash: { workflowGroupId: catalogId, audioHash } },
      });
      detachedEventId = assignment.eventId;
      if (assignment.isPrimary && assignment.event.released) {
        await tx.catalogEvent.update({
          where: { id: assignment.eventId },
          data: { released: false },
        });
        unreleasedEventId = assignment.eventId;
      }
    }

    const metadata = await tx.audioMetadata.deleteMany({
      where: { workflowGroupId: catalogId, audioHash },
    });
    const progress = await tx.recordingPlaybackProgress.deleteMany({ where: { audioHash } });
    const notifications = await tx.recordingNotification.deleteMany({
      where: { catalogId, audioHash },
    });

    await tx.workflowGroup.update({
      where: { id: catalogId },
      data: { updatedAt: new Date() },
    });

    return {
      detachedEventId,
      unreleasedEventId,
      metadataDeleted: metadata.count,
      progressDeleted: progress.count,
      notificationsDeleted: notifications.count,
    };
  });
}
