import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { unauthorized } from "@/lib/api";
import { constantTimeEqual } from "@/lib/security/constant-time";

const BESEDY_JOB_SERVICE_SECRET = process.env.BESEDY_JOB_SERVICE_SECRET?.trim();

export function authorizeDeepSearchServiceRequest(
  request: NextRequest,
): NextResponse | null {
  const authHeader = request.headers.get("Authorization");
  if (
    !BESEDY_JOB_SERVICE_SECRET ||
    authHeader === null ||
    !constantTimeEqual(authHeader, `Bearer ${BESEDY_JOB_SERVICE_SECRET}`)
  ) {
    return unauthorized("Unauthorized");
  }
  return null;
}

export async function catalogExists(catalogId: string): Promise<boolean> {
  const catalog = await prisma.workflowGroup.findUnique({
    where: { id: catalogId },
    select: { id: true },
  });
  return catalog !== null;
}

export async function getCatalogRecordingMetadata(
  catalogId: string,
  audioHash: string,
) {
  return prisma.audioMetadata.findUnique({
    where: {
      workflowGroupId_audioHash: {
        workflowGroupId: catalogId,
        audioHash,
      },
    },
    include: {
      location: { select: { id: true, name: true } },
      recorder: { select: { id: true, name: true } },
    },
  });
}

export function formatDeepSearchMetadata(
  metadata: Awaited<ReturnType<typeof getCatalogRecordingMetadata>>,
) {
  if (!metadata) {
    return null;
  }

  return {
    date: {
      year: metadata.dateYear ?? null,
      month: metadata.dateMonth ?? null,
      day: metadata.dateDay ?? null,
    },
    location: metadata.location
      ? { id: metadata.location.id, name: metadata.location.name }
      : null,
    recorder: metadata.recorder
      ? { id: metadata.recorder.id, name: metadata.recorder.name }
      : null,
  };
}
