import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateParams, validateRequestBody } from "@/lib/api/validation";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { logAuditEvent } from "@/lib/audit/logger";
import { AuthError, requireAuth } from "@/lib/auth/permissions";
import { appendGuideRevision, getActiveGuide } from "@/lib/correction/guide";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const GuideSchema = z.object({ body: z.string().min(1).max(50_000) }).strict();

/** Every corrector reads the guide; only a catalog administrator writes one. */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const catalogId = paramsResult.data.id;

    const userId = await requireAuth();
    const capability = await getCatalogCapability(catalogId, userId);
    if (!capability.canCorrectTranscripts && !capability.canEditCorrectionGuide) {
      throw new AuthError("Access denied to the correction guide", 403);
    }

    return NextResponse.json({
      guide: await getActiveGuide(catalogId),
      canEdit: capability.canEditCorrectionGuide,
    });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}

/**
 * PUT - append a revision. It becomes active at once and invalidates no
 * decision: people agreed about words, not about a document.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const catalogId = paramsResult.data.id;

    const bodyResult = await validateRequestBody(request, GuideSchema);
    if (!bodyResult.success) return bodyResult.response;

    const userId = await requireAuth();
    const capability = await getCatalogCapability(catalogId, userId);
    if (!capability.canEditCorrectionGuide) {
      throw new AuthError("Editing the correction guide is not permitted", 403);
    }

    const guide = await appendGuideRevision(catalogId, bodyResult.data.body, userId);

    await logAuditEvent({
      userId,
      action: "TRANSCRIPT_GUIDE_UPDATED",
      resource: "transcript_correction_guide",
      resourceId: catalogId,
      catalogId,
      payload: { revisionId: guide.revisionId },
    });

    return NextResponse.json({ guide, canEdit: true });
  } catch (error) {
    return handleCorrectionRouteError(error, "update");
  }
}
