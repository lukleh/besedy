import { NextRequest, NextResponse } from "next/server";
import { getFullCatalogEntry } from "@/lib/catalog";
import {
  transformArchivedEntry,
  transformDuplicateEntry,
  transformMetadataEntry,
} from "@/types/catalog";
import { AuthError } from "@/lib/auth/permissions";
import {
  resolveCatalogRecordingRouteAccess,
  requireCatalogRecordingEditAccess,
} from "@/lib/access/catalog-recording-route-access";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { validateParams } from "@/lib/api";
import { toCatalogEntryResponse } from "@/types/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

/**
 * GET /api/catalogs/:id/recordings/:hash/details - Get full CSV details for a recording
 *
 * Returns selected CSV fields mapped for UI display plus duplicate entries.
 * Used by the edit page to display source data alongside curated metadata.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogHashParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, hash } = paramsResult.data;

    const access = await resolveCatalogRecordingRouteAccess(catalogId, hash);
    if (!access.ok) {
      return access.response;
    }

    const deniedResponse = await requireCatalogRecordingEditAccess(access, {
      auditResource: "catalog",
      deniedMessage: "Edit permission required for recording details",
    });
    if (deniedResponse) {
      return deniedResponse;
    }

    // Get full recording details (paths derived from besedy.toml config)
    const result = await getFullCatalogEntry(catalogId, hash);

    if (!result) {
      return NextResponse.json(
        { error: "Recording not found" },
        { status: 404 }
      );
    }

    const sourceMetadata = transformMetadataEntry(result.fullMetadata);
    const sourceArchived = transformArchivedEntry(result.fullArchived);
    const duplicates = result.duplicates.map(transformDuplicateEntry);

    return NextResponse.json({
      hash,
      entry: toCatalogEntryResponse(result.entry),
      sourceMetadata,
      sourceArchived,
      duplicates,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error fetching recording details:", error);
    return NextResponse.json(
      { error: "Failed to fetch recording details" },
      { status: 500 }
    );
  }
}
