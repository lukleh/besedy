import prisma from '@/lib/db';
import { logMetadataUpdated } from '@/lib/audit/logger';
import { attachRecordingsToEvent } from '@/lib/catalog-events/attach-recordings';
import { CREATE_DISTINCT_EVENT_INTENT } from '@/lib/catalog-events/create-conflict';
import { createEventFromRecording } from '@/lib/catalog-events/create-from-recording';
import { createServerLogger } from '@/lib/log/server';
import type { IntakeRow } from './server';

const logger = createServerLogger('ingest-event');

export interface IntakeEventOutcome {
  eventId: number | null;
  /**
   * Set when the upload named a place and date but no event was assigned, or
   * when only a recorder was given and it could not be saved.
   */
  errorCode: 'event_exists' | 'event_not_created' | 'metadata_not_saved' | null;
  errorMessage: string | null;
}

const NO_EVENT: IntakeEventOutcome = {
  eventId: null,
  errorCode: null,
  errorMessage: null,
};

/**
 * After a successful ingest and catalog sync, store the place, date and
 * recorder entered on upload as the recording's metadata, and create its
 * unreleased event from the place and date.
 *
 * An upload without a place and date gets no event; its recorder is still
 * saved. A recording joins the event chosen on upload, or the event an earlier
 * file of the same upload got; otherwise it creates one, a separate one when
 * that was chosen. When events already cover
 * that place and date, the recording may belong to one of them, so it is left
 * unassigned for the admin to decide on the recording page. A recording that
 * already belongs to an event keeps its metadata, since an admin may have
 * corrected it while the outcome waited to be applied. Never throws: the
 * recording is in the catalog either way, so the ingest still succeeds.
 */
export async function assignIntakeEvent(
  row: IntakeRow,
  audioHash: string,
): Promise<IntakeEventOutcome> {
  const wantsEvent = row.locationId != null && row.dateYear != null;
  if (!wantsEvent && row.recorderId == null) return NO_EVENT;
  const userId = row.requestedById;
  if (!userId) {
    // Every metadata change is audited under its actor; without the uploader
    // there is none, so nothing is written and an admin enters it by hand.
    return wantsEvent
      ? {
          eventId: null,
          errorCode: 'event_not_created',
          errorMessage:
            'The uploading user no longer exists, so no event was created and the metadata was not saved.',
        }
      : {
          eventId: null,
          errorCode: 'metadata_not_saved',
          errorMessage: 'The uploading user no longer exists, so the recorder was not saved.',
        };
  }
  const workflowGroupId = row.workflowGroupId;
  // Only what the upload named; a recorder-only upload leaves place and date alone.
  const metadata = {
    ...(wantsEvent
      ? {
          locationId: row.locationId,
          dateYear: row.dateYear,
          dateMonth: row.dateMonth,
          dateDay: row.dateDay,
        }
      : {}),
    ...(row.recorderId != null ? { recorderId: row.recorderId } : {}),
  };

  try {
    let metadataWritten = false;
    const result = await prisma.$transaction(async (tx) => {
      const assigned = await tx.catalogEventRecording.findUnique({
        where: { workflowGroupId_audioHash: { workflowGroupId, audioHash } },
        select: { eventId: true },
      });
      if (assigned) {
        return { kind: 'already_assigned' as const, eventId: assigned.eventId };
      }
      await tx.audioMetadata.upsert({
        where: { workflowGroupId_audioHash: { workflowGroupId, audioHash } },
        update: metadata,
        create: { workflowGroupId, audioHash, tags: [], verified: false, ...metadata },
      });
      await tx.workflowGroup.update({
        where: { id: workflowGroupId },
        data: { updatedAt: new Date() },
      });
      metadataWritten = true;
      if (!wantsEvent) return { kind: 'no_event' as const };

      // Join an event chosen on upload, or the one an earlier file of the same
      // upload got; only the first file of a new event creates it.
      const joinEventId =
        row.targetEventId ??
        (row.uploadBatchId
          ? ((
              await tx.recordingIntake.findFirst({
                where: {
                  workflowGroupId,
                  uploadBatchId: row.uploadBatchId,
                  id: { not: row.id },
                  eventId: { not: null },
                },
                orderBy: { finishedAt: 'asc' },
                select: { eventId: true },
              })
            )?.eventId ?? null)
          : null);
      if (joinEventId != null) {
        const attached = await attachRecordingsToEvent(tx, {
          catalogId: workflowGroupId,
          eventId: joinEventId,
          audioHashes: [audioHash],
        });
        return attached.kind === 'success' && attached.attachedAudioHashes.length === 1
          ? { kind: 'attached' as const, eventId: joinEventId }
          : {
              kind: 'attach_failed' as const,
              eventId: joinEventId,
              reason:
                attached.kind === 'event_not_found'
                  ? 'the event no longer exists'
                  : (attached.errors[0]?.reason ?? 'unknown'),
            };
      }
      return createEventFromRecording(tx, {
        workflowGroupId,
        audioHash,
        userId,
        intent: row.createDistinctEvent ? CREATE_DISTINCT_EVENT_INTENT : undefined,
      });
    });
    if (metadataWritten) {
      // The writes are committed; a failed audit entry must not report them as failed.
      await logMetadataUpdated(userId, audioHash, workflowGroupId, Object.keys(metadata)).catch(
        (error: unknown) =>
          logger.warn('Audit entry for ingest metadata failed', {
            intakeId: row.id,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    }

    switch (result.kind) {
      case 'no_event':
        return NO_EVENT;
      case 'created':
      case 'attached':
      case 'already_assigned':
        return { eventId: result.eventId, errorCode: null, errorMessage: null };
      case 'attach_failed':
        return {
          eventId: null,
          errorCode: 'event_not_created',
          errorMessage: `Could not add the recording to event #${result.eventId}: ${result.reason}.`,
        };
      case 'needs_destination_decision':
        return {
          eventId: null,
          errorCode: 'event_exists',
          errorMessage:
            'Events already cover this place and date: ' +
            result.details.candidates
              .map((candidate) => candidate.title ?? `#${candidate.id}`)
              .join(', ') +
            '. Assign the recording on its page.',
        };
      default:
        return {
          eventId: null,
          errorCode: 'event_not_created',
          errorMessage: `No event was created (${result.kind}).`,
        };
    }
  } catch (error) {
    // A concurrent completion of the same intake may have assigned the
    // recording first, which makes this transaction fail on the assignment's
    // key. Report the winner's event rather than overwrite it with a failure.
    const winner = await prisma.catalogEventRecording
      .findUnique({
        where: { workflowGroupId_audioHash: { workflowGroupId, audioHash } },
        select: { eventId: true },
      })
      .catch(() => null);
    if (winner) {
      return { eventId: winner.eventId, errorCode: null, errorMessage: null };
    }
    const detail = error instanceof Error ? error.message : String(error);
    logger.error('Saving the upload metadata or event for an ingested recording failed', {
      intakeId: row.id,
      error: detail,
    });
    return wantsEvent
      ? {
          eventId: null,
          errorCode: 'event_not_created',
          // The metadata was written in the same transaction, so it is gone too.
          errorMessage: `No event was created and the upload's ${
            row.recorderId != null ? 'place, date and recorder were' : 'place and date were'
          } not saved: ${detail}`,
        }
      : {
          eventId: null,
          errorCode: 'metadata_not_saved',
          errorMessage: `The recorder was not saved: ${detail}`,
        };
  }
}
