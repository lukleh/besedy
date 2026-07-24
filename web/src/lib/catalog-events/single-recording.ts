import type { PrismaClient } from "@/generated/prisma/client";

type EventStateClient = {
  catalogEvent: Pick<PrismaClient["catalogEvent"], "findUnique" | "updateMany">;
  catalogEventRecording: Pick<
    PrismaClient["catalogEventRecording"],
    "findMany" | "updateMany"
  >;
};

export async function ensureSingleRecordingEventState(
  client: EventStateClient,
  workflowGroupId: string,
  eventId: number,
  updatedById: string
): Promise<boolean> {
  const [event, recordings] = await Promise.all([
    client.catalogEvent.findUnique({
      where: { id: eventId },
      select: { id: true, released: true },
    }),
    client.catalogEventRecording.findMany({
      where: { eventId, workflowGroupId },
      select: { audioHash: true, isPrimary: true },
      orderBy: [{ sortOrder: "asc" }, { audioHash: "asc" }],
    }),
  ]);

  if (!event || recordings.length !== 1) {
    return false;
  }

  let recording = recordings[0];
  let changed = false;

  if (!recording.isPrimary) {
    const promoteResult = await client.catalogEventRecording.updateMany({
      where: {
        eventId,
        workflowGroupId,
        audioHash: recording.audioHash,
        isPrimary: false,
      },
      data: { isPrimary: true },
    });
    if (promoteResult.count === 0) {
      return false;
    }
    recording = { ...recording, isPrimary: true };
    changed = true;
  }

  if (!event.released) {
    const releaseResult = await client.catalogEvent.updateMany({
      where: {
        id: eventId,
        workflowGroupId,
        released: false,
        recordings: {
          some: {
            workflowGroupId,
            audioHash: recording.audioHash,
            isPrimary: true,
          },
          every: {
            workflowGroupId,
            audioHash: recording.audioHash,
          },
        },
      },
      data: {
        released: true,
        updatedById,
      },
    });
    if (releaseResult.count > 0) {
      changed = true;
    }
  }

  return changed;
}
