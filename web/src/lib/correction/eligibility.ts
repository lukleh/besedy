import prisma from "@/lib/db";

/**
 * v1 corrects only the primary recording of an event.
 *
 * Every other recording has its own audio hash and timing and inherits
 * nothing from a primary one, so it has no correction path — and therefore no
 * publication gate either. It keeps the configured machine transcript for
 * reading and download.
 */
export async function isCorrectionEligibleRecording(
  catalogId: string,
  audioHash: string
): Promise<boolean> {
  const assignment = await prisma.catalogEventRecording.findUnique({
    where: {
      workflowGroupId_audioHash: {
        workflowGroupId: catalogId,
        audioHash,
      },
    },
    select: { isPrimary: true },
  });

  return assignment?.isPrimary === true;
}

/** Bulk form for the export and listing paths, which ask about many hashes. */
export async function listCorrectionEligibleHashes(
  catalogId: string,
  audioHashes: readonly string[]
): Promise<Set<string>> {
  if (audioHashes.length === 0) return new Set();

  const rows = await prisma.catalogEventRecording.findMany({
    where: {
      workflowGroupId: catalogId,
      audioHash: { in: [...audioHashes] },
      isPrimary: true,
    },
    select: { audioHash: true },
  });

  return new Set(rows.map((row) => row.audioHash));
}
