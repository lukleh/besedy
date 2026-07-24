import type { PrismaClient } from "@/generated/prisma/client";

type PublicationClient = {
  catalogEntry: Pick<PrismaClient["catalogEntry"], "updateMany">;
  catalogEvent: Pick<PrismaClient["catalogEvent"], "findUnique">;
  catalogEventRecording: Pick<
    PrismaClient["catalogEventRecording"],
    "findMany" | "findUnique"
  >;
  workflowGroup: Pick<PrismaClient["workflowGroup"], "update">;
};

export async function publishRecordingHashes(
  client: Pick<PublicationClient, "catalogEntry" | "workflowGroup">,
  workflowGroupId: string,
  audioHashes: string[]
): Promise<number> {
  const uniqueHashes = Array.from(new Set(audioHashes));
  if (uniqueHashes.length === 0) {
    return 0;
  }

  const result = await client.catalogEntry.updateMany({
    where: {
      workflowGroupId,
      audioHash: { in: uniqueHashes },
      isActionable: true,
      isPublished: false,
    },
    data: {
      isPublished: true,
    },
  });

  if (result.count > 0) {
    await client.workflowGroup.update({
      where: { id: workflowGroupId },
      data: { updatedAt: new Date() },
    });
  }

  return result.count;
}

export async function publishReleasedEventRecordings(
  client: PublicationClient,
  workflowGroupId: string,
  eventId: number
): Promise<number> {
  const event = await client.catalogEvent.findUnique({
    where: { id: eventId },
    select: { released: true },
  });

  if (!event?.released) {
    return 0;
  }

  const recordings = await client.catalogEventRecording.findMany({
    where: { workflowGroupId, eventId },
    select: { audioHash: true },
  });

  return publishRecordingHashes(
    client,
    workflowGroupId,
    recordings.map((recording) => recording.audioHash)
  );
}

export async function isRecordingInReleasedEvent(
  client: Pick<PublicationClient, "catalogEventRecording">,
  workflowGroupId: string,
  audioHash: string
): Promise<boolean> {
  const assignment = await client.catalogEventRecording.findUnique({
    where: {
      workflowGroupId_audioHash: {
        workflowGroupId,
        audioHash,
      },
    },
    select: {
      event: {
        select: {
          released: true,
        },
      },
    },
  });

  return assignment?.event.released ?? false;
}
