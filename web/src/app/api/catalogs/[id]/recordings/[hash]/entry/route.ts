import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getCatalogEntry, countDuplicatesByHash } from "@/lib/catalog";
import {
  resolveCatalogRecordingRouteAccess,
  requireCatalogAccess,
} from "@/lib/access/catalog-recording-route-access";
import { logAccessDenied } from "@/lib/audit/logger";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { validateParams } from "@/lib/api";
import { toCatalogEntryResponse } from "@/types/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

function isAuthError(error: unknown): error is { message: string; statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    "message" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number" &&
    typeof (error as { message: unknown }).message === "string"
  );
}

/**
 * GET /api/catalogs/:id/recordings/:hash/entry - Get a single enriched catalog entry
 *
 * Returns the catalog entry with curated metadata and permissions.
 * This is more efficient than fetching the entire catalog for a single lookup.
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
    const { userId, capability } = access;

    const deniedCatalogResponse = await requireCatalogAccess(access, {
      auditResource: "catalog_entry",
      deniedMessage: "Access denied to this catalog",
      auditResourceId: catalogId,
    });
    if (deniedCatalogResponse) {
      return deniedCatalogResponse;
    }

    // Get single catalog entry (paths derived from besedy.toml config)
    const entry = await getCatalogEntry(catalogId, hash);

    if (!entry) {
      return NextResponse.json(
        { error: "Recording not found in catalog" },
        { status: 404 }
      );
    }

    if (!capability.canAccessRecording) {
      await logAccessDenied(
        userId,
        "catalog_entry",
        hash,
        { reason: "Recording is not published for listeners", catalogId }
      );
      return NextResponse.json(
        { error: "Recording not found in catalog" },
        { status: 404 }
      );
    }

    // Get curated metadata from database
    const metadata = await prisma.audioMetadata.findUnique({
      where: {
        workflowGroupId_audioHash: {
          workflowGroupId: catalogId,
          audioHash: hash,
        },
      },
      include: {
        recorder: true,
        location: true,
        album: true,
      },
    });

    // Get duplicate count from DB serving table
    const duplicateCounts = await countDuplicatesByHash(catalogId);
    const duplicateCount = duplicateCounts.get(hash) ?? 0;

    // Format curated date as DD.MM.YYYY (or partial if incomplete)
    let curatedDate: string | null = null;
    if (metadata?.dateYear || metadata?.dateMonth || metadata?.dateDay) {
      const parts: string[] = [];
      if (metadata.dateDay) parts.push(String(metadata.dateDay));
      if (metadata.dateMonth) parts.push(String(metadata.dateMonth));
      if (metadata.dateYear) parts.push(String(metadata.dateYear));
      curatedDate = parts.join(".");
    }

    // Build enriched entry
    const enrichedEntry = {
      ...entry,
      curated: !!metadata,
      curatedTitle: metadata?.title,
      curatedArtist: metadata?.artist,
      curatedDate,
      dateYear: metadata?.dateYear ?? null,
      dateMonth: metadata?.dateMonth ?? null,
      dateDay: metadata?.dateDay ?? null,
      verified: metadata?.verified ?? false,
      verifiedAt: metadata?.verifiedAt?.toISOString() ?? null,
      tags: metadata?.tags ?? [],
      notes: metadata?.notes ?? null,
      recorderId: metadata?.recorderId ?? null,
      recorder: metadata?.recorder
        ? { id: metadata.recorder.id, name: metadata.recorder.name }
        : null,
      locationId: metadata?.locationId ?? null,
      location: metadata?.location
        ? { id: metadata.location.id, name: metadata.location.name }
        : null,
      albumId: metadata?.albumId ?? null,
      album: metadata?.album
        ? { id: metadata.album.id, name: metadata.album.name }
        : null,
      part: metadata?.part ?? null,
      duplicateCount,
    };

    return NextResponse.json({
      entry: toCatalogEntryResponse(enrichedEntry),
      canViewTranscripts: capability.canViewRecordingTranscripts,
      canEditMetadata: capability.canEditRecording,
      canDownload: capability.canDownloadRecording,
    });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error fetching catalog entry:", error);
    return NextResponse.json(
      { error: "Failed to fetch catalog entry" },
      { status: 500 }
    );
  }
}
