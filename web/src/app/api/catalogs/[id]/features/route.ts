import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import { handlePrismaError, notFound, validateParams } from "@/lib/api";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import { getCatalogFeaturesForUser } from "@/lib/features/capabilities";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/catalogs/:id/features
 * Returns feature capabilities for this user scoped to one catalog.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await requireAuth();

    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId } = paramsResult.data;
    const { searchParams } = new URL(_request.url);
    const includeInactive = searchParams.get("includeInactive") === "true";

    const featureData = await getCatalogFeaturesForUser(catalogId, userId, {
      activeCatalogOnly: includeInactive ? false : undefined,
    });
    if (!featureData.catalogExists) {
      return notFound("catalog");
    }

    return NextResponse.json(featureData.data);
  } catch (error) {
    return handlePrismaError(error, "catalog features", "fetch");
  }
}
