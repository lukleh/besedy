import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { handlePrismaError, notFound, validateParams } from "@/lib/api";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import { findActiveCatalog } from "@/lib/catalog/resolve-group";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/catalogs/:id/capability
 * Returns lightweight capability flags for shell/navigation usage.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await requireAuth();

    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId } = paramsResult.data;

    const capability = await getCatalogCapability(catalogId, userId, {
      activeCatalogOnly: false,
    });
    if (!capability.catalogExists || !capability.hasAccess) {
      return notFound("catalog");
    }

    return NextResponse.json({
      canManageAccess: capability.canManageAccess,
      canAccessSettings: capability.canAccessSettings,
      // Who the correction overview is for: everyone who corrects. This route
      // resolves access for inactive catalogs too, which the overview page and
      // API do not serve, so the link follows their rule.
      canViewCorrectionOverview:
        capability.canCorrectTranscripts && (await findActiveCatalog(catalogId)) !== null,
    });
  } catch (error) {
    return handlePrismaError(error, "catalog capability", "fetch");
  }
}
