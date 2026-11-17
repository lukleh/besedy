import type { Prisma } from "@/generated/prisma/client";
import { publishRecordingHashes } from "@/lib/catalog-events/publication";

export type AttachErrorReason =
  | "missing_in_catalog"
  | "non_actionable"
  | "already_attached"
  | "assigned_to_other_event";

export type AttachResult =
  | {
      kind: "success";
      attachedAudioHashes: string[];
      errors: Array<{ audioHash: string; reason: AttachErrorReason }>;
    }
  | {
      kind: "bad_request";
      message: string;
      errors: Array<{ audioHash: string; reason: AttachErrorReason }>;
    }
  | { kind: "event_not_found" };

/**
 * Attach catalog recordings to an event as non-primary recordings, inside the
 * caller's transaction. Recordings already on another event, missing from the
 * catalog or not actionable are reported, not moved. Attaching to a released
 * event publishes the attached recordings.
 */
export async function attachRecordingsToEvent(
  tx: Prisma.TransactionClient,
  input: { catalogId: string; eventId: number; audioHashes: string[] }
): Promise<AttachResult> {
  const { catalogId, eventId } = input;
  const hashes = Array.from(new Set(input.audioHashes));
  await tx.$queryRaw`
    SELECT id
    FROM catalog_event
    WHERE id = ${eventId}
    FOR UPDATE
  `;

  const event = await tx.catalogEvent.findFirst({
    where: { id: eventId, workflowGroupId: catalogId },
    select: { id: true, workflowGroupId: true, released: true },
  });
  if (!event) {
    return { kind: "event_not_found" };
  }

  const [catalogRows, existingAssignments] = await Promise.all([
    tx.catalogEntry.findMany({
      where: {
        workflowGroupId: event.workflowGroupId,
        audioHash: { in: hashes },
      },
      select: { audioHash: true, isActionable: true },
    }),
    tx.catalogEventRecording.findMany({
      where: {
        workflowGroupId: event.workflowGroupId,
        audioHash: { in: hashes },
      },
      select: { audioHash: true, eventId: true },
    }),
  ]);

  const catalogByHash = new Map(catalogRows.map((row) => [row.audioHash, row]));
  const assignmentByHash = new Map(
    existingAssignments.map((row) => [row.audioHash, row.eventId])
  );

  const errorByHash = new Map<string, AttachErrorReason>();
  const attachCandidates: string[] = [];

  for (const audioHash of hashes) {
    const catalogRow = catalogByHash.get(audioHash);
    if (!catalogRow) {
      errorByHash.set(audioHash, "missing_in_catalog");
      continue;
    }
    if (!catalogRow.isActionable) {
      errorByHash.set(audioHash, "non_actionable");
      continue;
    }

    const assignedEventId = assignmentByHash.get(audioHash);
    if (assignedEventId === event.id) {
      errorByHash.set(audioHash, "already_attached");
      continue;
    }
    if (assignedEventId !== undefined && assignedEventId !== event.id) {
      errorByHash.set(audioHash, "assigned_to_other_event");
      continue;
    }

    attachCandidates.push(audioHash);
  }

  if (attachCandidates.length > 0) {
    await tx.catalogEventRecording.createMany({
      data: attachCandidates.map((audioHash) => ({
        eventId: event.id,
        workflowGroupId: event.workflowGroupId,
        audioHash,
      })),
      skipDuplicates: true,
    });
  }

  // Re-read current assignments to ensure response reflects true DB state
  // even under concurrent attach operations.
  const postWriteAssignments =
    attachCandidates.length > 0
      ? await tx.catalogEventRecording.findMany({
          where: {
            workflowGroupId: event.workflowGroupId,
            audioHash: { in: attachCandidates },
          },
          select: { audioHash: true, eventId: true },
        })
      : [];

  const postWriteAssignmentByHash = new Map(
    postWriteAssignments.map((row) => [row.audioHash, row.eventId])
  );
  const attachedAudioHashes: string[] = [];

  for (const audioHash of attachCandidates) {
    const assignedEventId = postWriteAssignmentByHash.get(audioHash);
    if (assignedEventId === event.id) {
      attachedAudioHashes.push(audioHash);
      continue;
    }

    // Lost race to another event assignment or row disappeared during concurrent writes.
    errorByHash.set(audioHash, "assigned_to_other_event");
  }

  if (event.released && attachedAudioHashes.length > 0) {
    await publishRecordingHashes(tx, event.workflowGroupId, attachedAudioHashes);
  }

  const errors = hashes.flatMap((audioHash) => {
    const reason = errorByHash.get(audioHash);
    return reason ? [{ audioHash, reason }] : [];
  });

  if (attachedAudioHashes.length === 0 && errors.length > 0) {
    return {
      kind: "bad_request",
      message: "No recordings could be attached",
      errors,
    };
  }

  return {
    kind: "success",
    attachedAudioHashes,
    errors,
  };
}
