import { NextRequest, NextResponse } from "next/server";
import { handlePrismaError, validateParams } from "@/lib/api";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { getEventCatalogHealth } from "@/lib/catalog-events/health";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/catalogs/:id/events/health
 * Admin event-health counters for catalog settings.
 * Labs-gated via requireCatalogEventsAccess.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId } = paramsResult.data;
    const { searchParams } = new URL(_request.url);
    const includeInactive = searchParams.get("includeInactive") === "true";

    await requireCatalogEventsAccess(catalogId, "edit", {
      activeCatalogOnly: includeInactive ? false : undefined,
    });

    const health = await getEventCatalogHealth(catalogId);
    return NextResponse.json(health);
  } catch (error) {
    return handlePrismaError(error, "catalog event health", "fetch");
  }
}
