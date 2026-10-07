import { NextRequest, NextResponse } from "next/server";
import { validateParams } from "@/lib/api/validation";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { AuthError, requireAuth } from "@/lib/auth/permissions";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import { loadCorrectionOverview } from "@/lib/correction/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET - correction across the whole catalog: what is in progress, what still
 * wants this person, what a curator can publish and what nobody has started.
 *
 * Open to everyone who corrects or publishes, and limited to the recordings
 * they may see: a corrector who cannot see unreleased material does not learn
 * of it here either.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const catalogId = paramsResult.data.id;

    const userId = await requireAuth();
    const capability = await getCatalogCapability(catalogId, userId);
    if (!capability.catalogExists || !capability.hasAccess) {
      throw new AuthError("Catalog not found", 404);
    }
    if (!capability.canCorrectTranscripts && !capability.canPublishTranscript) {
      throw new AuthError("Access denied to the correction overview", 403);
    }

    const overview = await loadCorrectionOverview({
      catalogId,
      actorKey: userId,
      canSeeUnreleased: capability.canSeeUnreleased,
    });

    return NextResponse.json({
      catalogId,
      canPublish: capability.canPublishTranscript,
      ...overview,
    });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}
