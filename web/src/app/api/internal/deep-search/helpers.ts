import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { unauthorized } from "@/lib/api";
import { constantTimeEqual } from "@/lib/security/constant-time";
import { getCatalogCapability } from "@/lib/access/capabilities";
import type { CatalogGrant } from "@/lib/policy/catalog-permissions";
import {
  canViewRecordingForAccessLevel,
  requiresReadyRecordingScope,
} from "@/lib/policy/recording";

const BESEDY_JOB_SERVICE_SECRET = process.env.BESEDY_JOB_SERVICE_SECRET?.trim();

export function authorizeDeepSearchServiceRequest(
  request: NextRequest
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

/**
 * The visibility a deep-search job runs under.
 *
 * A job is asked for by a person, so it sees what that person sees. The service
 * secret says the caller is our own worker; it says nothing about on whose
 * behalf, which is why the request carries the requester.
 *
 * A catalog administrator is unscoped, which is what `null` is for.
 */
export async function resolveDeepSearchJobGrant(
  catalogId: string,
  requestedById: string
): Promise<{ ok: true; grant: CatalogGrant | null } | { ok: false }> {
  const capability = await getCatalogCapability(catalogId, requestedById);
  if (capability.isCatalogAdmin) return { ok: true, grant: null };
  if (
    !capability.hasAccess ||
    !capability.canViewTranscripts ||
    !capability.catalogGrant
  ) {
    return { ok: false };
  }
  return { ok: true, grant: capability.catalogGrant };
}

/**
 * Whether a job running under this grant may see one recording.
 *
 * The search is scoped, so the identifiers a job holds are already ones it may
 * see. This is the second lock on the same door: an expansion asked for by hash
 * or by chunk answers to the same visibility the search did.
 */
export async function deepSearchJobCanSeeRecording(
  catalogId: string,
  audioHash: string,
  grant: CatalogGrant | null
): Promise<boolean> {
  if (!requiresReadyRecordingScope(grant)) return true;

  const entry = await prisma.catalogEntry.findUnique({
    where: {
      workflowGroupId_audioHash: { workflowGroupId: catalogId, audioHash },
    },
    select: { isActionable: true, isPublished: true },
  });

  return !!entry && canViewRecordingForAccessLevel(grant, entry);
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
  audioHash: string
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
  metadata: Awaited<ReturnType<typeof getCatalogRecordingMetadata>>
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
