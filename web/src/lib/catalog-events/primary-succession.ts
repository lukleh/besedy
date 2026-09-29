import type { Prisma } from "@/generated/prisma/client";
import { publishRecordingHashes } from "@/lib/catalog-events/publication";

export type LostPrimaryOutcome =
  | { kind: "promoted"; audioHash: string }
  | { kind: "unreleased" }
  | { kind: "unchanged" };

/**
 * Repair an event whose primary recording was just detached because the
 * recording left the catalog. The next playable recording (sort order, then
 * hash) becomes primary, so a released event stays released and visible. With
 * no playable recording left, a released event is unreleased instead, so it
 * never stays released without a primary. The event itself is kept either way:
 * it carries curated data that must not be lost with its recordings.
 *
 * The caller must hold the event row lock (`SELECT ... FOR UPDATE`).
 */
export async function replaceLostPrimaryRecording(
  tx: Prisma.TransactionClient,
  workflowGroupId: string,
  eventId: number,
): Promise<LostPrimaryOutcome> {
  const remaining = await tx.catalogEventRecording.findMany({
    where: { workflowGroupId, eventId },
    select: { audioHash: true, isPrimary: true },
    orderBy: [{ sortOrder: "asc" }, { audioHash: "asc" }],
  });
  if (remaining.some((recording) => recording.isPrimary)) {
    return { kind: "unchanged" };
  }

  const playable =
    remaining.length > 0
      ? await tx.catalogEntry.findMany({
          where: {
            workflowGroupId,
            audioHash: { in: remaining.map((recording) => recording.audioHash) },
            isActionable: true,
          },
          select: { audioHash: true },
        })
      : [];
  const playableHashes = new Set(playable.map((entry) => entry.audioHash));
  const next = remaining.find((recording) => playableHashes.has(recording.audioHash));

  if (next) {
    await tx.catalogEventRecording.update({
      where: {
        workflowGroupId_audioHash: { workflowGroupId, audioHash: next.audioHash },
      },
      data: { isPrimary: true },
    });
    const event = await tx.catalogEvent.findUnique({
      where: { id: eventId },
      select: { released: true },
    });
    if (event?.released) {
      await publishRecordingHashes(tx, workflowGroupId, [next.audioHash]);
    }
    return { kind: "promoted", audioHash: next.audioHash };
  }

  const unreleased = await tx.catalogEvent.updateMany({
    where: { id: eventId, workflowGroupId, released: true },
    data: { released: false },
  });
  return unreleased.count > 0 ? { kind: "unreleased" } : { kind: "unchanged" };
}
