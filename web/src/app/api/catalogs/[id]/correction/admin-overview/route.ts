import { NextRequest, NextResponse } from "next/server";
import { validateParams } from "@/lib/api/validation";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { AuthError, requireAuth } from "@/lib/auth/permissions";
import { loadCorrectionAdminOverview } from "@/lib/correction/admin-overview";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET - correction across the whole catalog for whoever looks after it: every
 * recording's progress, who is working where, whose work waits for a second
 * person and which spans are disputed.
 *
 * It names people and what each has done, so it sits with the authority that
 * administers correction rather than with everyone who corrects.
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
    if (!capability.canAdministerCorrection) {
      throw new AuthError("Access denied to the correction admin overview", 403);
    }

    const overview = await loadCorrectionAdminOverview({
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
