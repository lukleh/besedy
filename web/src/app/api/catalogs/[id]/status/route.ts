import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getCurrentUserId } from "@/lib/auth/permissions";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { TimestampIdParamSchema } from "@/lib/validation/schemas";
import { validateParams, notFound, forbidden, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/catalogs/:id/status - Lightweight catalog status check
 *
 * Returns lastModifiedAt and totalEntries for change detection.
 * Designed for frequent polling (every 5 minutes).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const paramsResult = validateParams(await params, TimestampIdParamSchema);
  if (!paramsResult.success) return paramsResult.response;
  const { id: catalogId } = paramsResult.data;

  // Check user access
  const userId = await getCurrentUserId();
  if (!userId) {
    return unauthorized();
  }
  const capability = await getCatalogCapability(catalogId, userId);
  if (!capability.catalogExists) {
    return notFound("catalog");
  }
  if (!capability.hasAccess) {
    return forbidden("Access denied");
  }

  // Get catalog with entry count
  const catalog = await prisma.workflowGroup.findFirst({
    where: { id: catalogId, isActive: true },
    select: {
      id: true,
      updatedAt: true,
      _count: { select: { metadata: true } },
    },
  });

  if (!catalog) {
    return notFound("catalog");
  }

  return NextResponse.json(
    {
      catalogId: catalog.id,
      lastModifiedAt: catalog.updatedAt.toISOString(),
      // Note: This is the count of curated AudioMetadata records, not total catalog entries
      curatedEntries: catalog._count.metadata,
    },
    {
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    }
  );
}
