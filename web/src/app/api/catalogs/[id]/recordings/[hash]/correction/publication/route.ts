import { NextRequest, NextResponse } from "next/server";
import { validateParams } from "@/lib/api/validation";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import {
  getPublicationEligibility,
  listPublications,
  publishTranscript,
  unpublishTranscript,
} from "@/lib/correction/publication-service";
import { requireActiveWorkspace } from "@/lib/correction/workspace-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    await requireCorrectionAccess(catalogId, hash, "publish");
    const workspace = await requireActiveWorkspace(catalogId, hash);

    return NextResponse.json({
      workspaceId: workspace.id,
      readerPublicationId: workspace.readerPublicationId,
      searchPublicationId: workspace.searchPublicationId,
      lockedByPublicationId: workspace.lockedByPublicationId,
      eligibility: await getPublicationEligibility(workspace.id),
      publications: await listPublications(workspace.id),
    });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}

/**
 * POST - publish or republish.
 *
 * The server rechecks every span here. Being the publisher is not a third
 * review and cannot carry an unfinished or disputed span past the gate.
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "publish");
    const result = await publishTranscript({ catalogId, audioHash: hash, userId });

    await logAuditEvent({
      userId,
      action: "TRANSCRIPT_PUBLISHED",
      resource: "transcript_correction",
      resourceId: hash,
      catalogId,
      payload: {
        publicationId: result.publicationId,
        status: result.status,
        reusedSnapshot: result.reused,
      },
    });

    return NextResponse.json(result, { status: result.status === "FAILED" ? 500 : 200 });
  } catch (error) {
    return handleCorrectionRouteError(error, "update");
  }
}

/**
 * DELETE - take the transcript off the reading surfaces.
 *
 * Search and agents keep the last corrected snapshot: an ordinary unpublish is
 * an editorial statement about reading, not a retraction of the words.
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "publish");
    const result = await unpublishTranscript({ catalogId, audioHash: hash });

    await logAuditEvent({
      userId,
      action: "TRANSCRIPT_UNPUBLISHED",
      resource: "transcript_correction",
      resourceId: hash,
      catalogId,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleCorrectionRouteError(error, "update");
  }
}
