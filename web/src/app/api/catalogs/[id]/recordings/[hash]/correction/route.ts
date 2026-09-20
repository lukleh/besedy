import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateParams, validateRequestBody } from "@/lib/api/validation";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { logAuditEvent } from "@/lib/audit/logger";
import { resolveTranscriptsPath } from "@/lib/paths";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import { isCorrectionEligibleRecording } from "@/lib/correction/eligibility";
import { getActiveGuide } from "@/lib/correction/guide";
import { getPublicationEligibility } from "@/lib/correction/publication-service";
import { resolveConfiguredDefaultBackend } from "@/lib/correction/source";
import {
  archiveWorkspace,
  computeProgress,
  findActiveWorkspace,
  startWorkspace,
} from "@/lib/correction/workspace-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

const ArchiveBodySchema = z
  .object({ reason: z.string().min(1).max(500) })
  .strict();

const StartBodySchema = z
  .object({
    /** The backend the start screen showed, so a changed default is refused */
    expectedBackend: z.string().min(3).nullish(),
  })
  .strict();

/**
 * GET - the state of correction for one recording.
 *
 * Opening this page creates nothing. Starting is a deliberate action, because
 * it freezes a source and writes several hundred rows.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const { capability } = await requireCorrectionAccess(catalogId, hash, "correct");
    const eligible = await isCorrectionEligibleRecording(catalogId, hash);
    const workspace = await findActiveWorkspace(catalogId, hash);
    const transcriptsPath = resolveTranscriptsPath(catalogId);

    return NextResponse.json({
      catalogId,
      audioHash: hash,
      eligible,
      canPublish: capability.canPublishTranscript,
      guide: await getActiveGuide(catalogId),
      /** What would be frozen if correction started now */
      candidateBackend: workspace
        ? null
        : await resolveConfiguredDefaultBackend(transcriptsPath, hash),
      workspace,
      progress: workspace ? await computeProgress(workspace.id) : null,
      publication: workspace
        ? await getPublicationEligibility(workspace.id)
        : null,
    });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}

/** POST - freeze the configured default transcript and import its segments. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, StartBodySchema);
    if (!bodyResult.success) return bodyResult.response;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "correct");

    const workspace = await startWorkspace({
      catalogId,
      audioHash: hash,
      transcriptsPath: resolveTranscriptsPath(catalogId),
      userId,
      expectedBackend: bodyResult.data.expectedBackend ?? null,
    });

    await logAuditEvent({
      userId,
      action: "TRANSCRIPT_CORRECTION_STARTED",
      resource: "transcript_correction",
      resourceId: hash,
      catalogId,
      payload: {
        workspaceId: workspace.id,
        backend: workspace.sourceBackend,
        sourceFingerprint: workspace.sourceFingerprint,
        spanCount: workspace.spanCount,
      },
    });

    return NextResponse.json({ workspace }, { status: 201 });
  } catch (error) {
    return handleCorrectionRouteError(error, "create");
  }
}

/**
 * DELETE - archive this workspace so a new one can be started.
 *
 * The exceptional path for a wrongly chosen source. Nothing is deleted: the
 * abandoned workspace and all of its history stay available for audit, and the
 * partial unique index is what lets a replacement exist beside it.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const bodyResult = await validateRequestBody(request, ArchiveBodySchema);
    if (!bodyResult.success) return bodyResult.response;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "administer");

    const workspace = await archiveWorkspace({
      catalogId,
      audioHash: hash,
      userId,
      reason: bodyResult.data.reason,
    });

    await logAuditEvent({
      userId,
      action: "TRANSCRIPT_CORRECTION_ARCHIVED",
      resource: "transcript_correction",
      resourceId: hash,
      catalogId,
      payload: {
        workspaceId: workspace.id,
        backend: workspace.sourceBackend,
        reason: bodyResult.data.reason,
      },
    });

    return NextResponse.json({ workspace });
  } catch (error) {
    return handleCorrectionRouteError(error, "delete");
  }
}
