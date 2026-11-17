import prisma from '@/lib/db';
import { logMetadataUpdated } from '@/lib/audit/logger';
import { createEventFromRecording } from '@/lib/catalog-events/create-from-recording';
import { createServerLogger } from '@/lib/log/server';
import type { IntakeRow } from './server';

const logger = createServerLogger('ingest-event');

const METADATA_FIELDS = ['locationId', 'dateYear', 'dateMonth', 'dateDay'];

export interface IntakeEventOutcome {
  eventId: number | null;
  /** Set when the upload named a place and date but no event was assigned. */
  errorCode: 'event_exists' | 'event_not_created' | null;
  errorMessage: string | null;
}

const NO_EVENT: IntakeEventOutcome = {
  eventId: null,
  errorCode: null,
  errorMessage: null,
};

/**
 * After a successful ingest and catalog sync, store the place and date entered
 * on upload as the recording's metadata and create its unreleased event.
 *
 * An upload without a place and date gets no event. When events already cover
 * that place and date, the recording may belong to one of them, so it is left
 * unassigned for the admin to decide on the recording page. Never throws: the
 * recording is in the catalog either way, so the ingest still succeeds.
 */
export async function assignIntakeEvent(
  row: IntakeRow,
  audioHash: string,
): Promise<IntakeEventOutcome> {
  if (row.locationId == null || row.dateYear == null) return NO_EVENT;
  const userId = row.requestedById;
  if (!userId) {
    return {
      eventId: null,
      errorCode: 'event_not_created',
      errorMessage: 'The uploading user no longer exists, so no event was created.',
    };
  }
  const workflowGroupId = row.workflowGroupId;
  const metadata = {
    locationId: row.locationId,
    dateYear: row.dateYear,
    dateMonth: row.dateMonth,
    dateDay: row.dateDay,
  };

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.audioMetadata.upsert({
        where: { workflowGroupId_audioHash: { workflowGroupId, audioHash } },
        update: metadata,
        create: { workflowGroupId, audioHash, tags: [], verified: false, ...metadata },
      });
      await tx.workflowGroup.update({
        where: { id: workflowGroupId },
        data: { updatedAt: new Date() },
      });
      return createEventFromRecording(tx, { workflowGroupId, audioHash, userId });
    });
    // The writes are committed; a failed audit entry must not report them as failed.
    await logMetadataUpdated(userId, audioHash, workflowGroupId, METADATA_FIELDS).catch(
      (error: unknown) =>
        logger.warn('Audit entry for ingest metadata failed', {
          intakeId: row.id,
          error: error instanceof Error ? error.message : String(error),
        }),
    );

    switch (result.kind) {
      case 'created':
      case 'already_assigned':
        return { eventId: result.eventId, errorCode: null, errorMessage: null };
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
    logger.error('Creating the event for an ingested recording failed', {
      intakeId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      eventId: null,
      errorCode: 'event_not_created',
      errorMessage: `No event was created: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
