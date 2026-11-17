import type { Prisma } from "@/generated/prisma/client";
import { loadEventCreationContext } from "@/lib/catalog-events/create-candidates";
import {
  buildEventCreationConflictDetails,
  CREATE_DISTINCT_EVENT_INTENT,
  type EventCreationConflictDetails,
} from "@/lib/catalog-events/create-conflict";
import { deriveEventTitle } from "@/lib/catalog-events/utils";

export type CreateFromRecordingResult =
  | { kind: "created"; eventId: number; title: string; sessionIndex: number }
  | { kind: "recording_not_found" }
  | { kind: "non_actionable" }
  | { kind: "already_assigned"; eventId: number }
  | { kind: "needs_destination_decision"; details: EventCreationConflictDetails }
  | { kind: "missing_metadata" };

export interface CreateFromRecordingInput {
  workflowGroupId: string;
  audioHash: string;
  userId: string;
  intent?: string;
}

/**
 * Create an unreleased event from one recording's location and date metadata
 * and make the recording its primary. Runs inside the caller's transaction.
 *
 * When events already cover that place and date, nothing is created unless
 * the caller confirmed a distinct event, because the recording may belong to
 * one of them.
 */
export async function createEventFromRecording(
  tx: Prisma.TransactionClient,
  input: CreateFromRecordingInput
): Promise<CreateFromRecordingResult> {
  const { workflowGroupId, audioHash, userId } = input;
  const [entry, metadata, existingAssignment] = await Promise.all([
    tx.catalogEntry.findFirst({
      where: { workflowGroupId, audioHash },
      select: { audioHash: true, isActionable: true },
    }),
    tx.audioMetadata.findFirst({
      where: { workflowGroupId, audioHash },
      select: {
        dateYear: true,
        dateMonth: true,
        dateDay: true,
        location: { select: { id: true, name: true } },
      },
    }),
    tx.catalogEventRecording.findUnique({
      where: { workflowGroupId_audioHash: { workflowGroupId, audioHash } },
      select: { eventId: true },
    }),
  ]);

  if (!entry) {
    return { kind: "recording_not_found" };
  }
  if (!entry.isActionable) {
    return { kind: "non_actionable" };
  }
  if (existingAssignment) {
    return { kind: "already_assigned", eventId: existingAssignment.eventId };
  }
  if (!metadata?.location || metadata.dateYear == null) {
    return { kind: "missing_metadata" };
  }

  const creationContext = await loadEventCreationContext(tx, {
    workflowGroupId,
    locationId: metadata.location.id,
    dateYear: metadata.dateYear,
    dateMonth: metadata.dateMonth ?? null,
    dateDay: metadata.dateDay ?? null,
  });

  if (
    creationContext.candidates.length > 0 &&
    input.intent !== CREATE_DISTINCT_EVENT_INTENT
  ) {
    return {
      kind: "needs_destination_decision",
      details: buildEventCreationConflictDetails(creationContext.candidates),
    };
  }

  // The browser confirms semantic intent, never a storage index. Re-read
  // the current candidates and allocate the index in this transaction.
  const sessionIndex = creationContext.nextSessionIndex;

  const title = deriveEventTitle(
    metadata.location.name,
    metadata.dateYear,
    metadata.dateMonth ?? null,
    metadata.dateDay ?? null,
    sessionIndex
  );

  const createdEvent = await tx.catalogEvent.create({
    data: {
      workflowGroupId,
      title,
      locationId: metadata.location.id,
      dateYear: metadata.dateYear,
      dateMonth: metadata.dateMonth ?? null,
      dateDay: metadata.dateDay ?? null,
      sessionIndex,
      released: false,
      createdById: userId,
      updatedById: userId,
    },
    select: { id: true, title: true },
  });

  await tx.catalogEventRecording.create({
    data: {
      eventId: createdEvent.id,
      workflowGroupId,
      audioHash,
      isPrimary: true,
    },
  });

  return {
    kind: "created",
    eventId: createdEvent.id,
    title: createdEvent.title ?? title,
    sessionIndex,
  };
}
