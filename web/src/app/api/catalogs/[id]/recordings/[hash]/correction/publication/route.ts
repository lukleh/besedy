import { NextRequest, NextResponse } from "next/server";
import { validateParams } from "@/lib/api/validation";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireCorrectionAccess } from "@/lib/correction/access";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import { getPublicationEligibility } from "@/lib/correction/publication-eligibility";
import {
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
      publicationId: workspace.publicationId,
      canUnpublish: workspace.canUnpublish,
      unpublishPending: workspace.unpublishPending,
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
      },
    });

    // A failed publication is a completed request with a recorded outcome,
    // not a server error: the page shows the cause and offers a retry.
    return NextResponse.json(result);
  } catch (error) {
    return handleCorrectionRouteError(error, "update");
  }
}

/**
 * DELETE - retract the corrected snapshot from reading and search/MCP.
 * Search returns to machine text asynchronously; repeating DELETE retries an
 * unfinished index sync without creating a different unpublish generation.
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const { userId } = await requireCorrectionAccess(catalogId, hash, "publish");
    const result = await unpublishTranscript({ catalogId, audioHash: hash, userId });

    await logAuditEvent({
      userId,
      action: "TRANSCRIPT_UNPUBLISHED",
      resource: "transcript_correction",
      resourceId: hash,
      catalogId,
      payload: { pendingIndexSync: result.pendingIndexSync },
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleCorrectionRouteError(error, "update");
  }
}
