import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { AuthError } from "@/lib/auth/permissions";
import {
  resolveCatalogRecordingRouteAccess,
  requireCatalogRecordingAccess,
} from "@/lib/access/catalog-recording-route-access";
import { CatalogHashParamSchema } from "@/lib/validation/schemas";
import { validateParams } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; hash: string }>;
}

interface AudioSource {
  id: string;
  label: string;
  type: "archived" | "listening";
  variant?: string;
  available: boolean;
}

/**
 * GET /api/catalogs/:id/recordings/:hash/audio/sources - List available audio sources
 *
 * Returns list of available audio sources (archived, listening variants)
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

    const deniedResponse = await requireCatalogRecordingAccess(access, {
      auditResource: "catalog",
      deniedMessage: "Access denied to this recording",
    });
    if (deniedResponse) {
      return deniedResponse;
    }

    const sources: AudioSource[] = [];

    // Always have archived source
    sources.push({
      id: "archived",
      label: "Archived",
      type: "archived",
      available: true, // If we got here, archived exists
    });

    // Check for variants with listening audio
    const variants = await prisma.workflowVariant.findMany({
      where: { workflowGroupId: catalogId },
      orderBy: [{ isDefault: "desc" }, { variant: "asc" }],
    });

    const listeningAvailability = await Promise.all(
      variants
        .filter((variant) => !!variant.listeningArchivedCatalogPath)
        .map(async (variant) => {
          const row = await prisma.catalogListeningEntry.findUnique({
            where: {
              workflowGroupId_variant_audioHash: {
                workflowGroupId: catalogId,
                variant: variant.variant,
                audioHash: hash,
              },
            },
            select: { audioHash: true },
          });
          return { variant, available: !!row };
        })
    );

    for (const item of listeningAvailability) {
      sources.push({
        id: `listening:${item.variant.variant}`,
        label: item.variant.label || `Listening (${item.variant.variant})`,
        type: "listening",
        variant: item.variant.variant,
        available: item.available,
      });
    }

    return NextResponse.json({
      hash,
      sources,
      defaultSource: "archived",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error fetching audio sources:", error);
    return NextResponse.json(
      { error: "Failed to fetch audio sources" },
      { status: 500 }
    );
  }
}
