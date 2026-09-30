import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { AuthError } from "@/lib/auth/permissions";
import {
  resolveCatalogRecordingRouteAccess,
  requireCatalogRecordingAccess,
} from "@/lib/access/catalog-recording-route-access";
import { CatalogHashParamSchema, type AudioFormat } from "@/lib/validation/schemas";
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
  /**
   * Files the audio route can serve for this source with `format=`: "webm"
   * when the WebM is catalogued, "aac" when its AAC-in-MP4 copy is (#291).
   */
  formats: AudioFormat[];
}

function formatsFor(
  row: { compressedPath: string | null; compressedAacPath: string | null } | null
): AudioFormat[] {
  const formats: AudioFormat[] = [];
  if (row?.compressedPath) formats.push("webm");
  if (row?.compressedAacPath) formats.push("aac");
  return formats;
}

/**
 * GET /api/catalogs/:id/recordings/:hash/audio/sources - List available audio sources
 *
 * Returns list of available audio sources (archived, listening variants),
 * each with the formats it can be served in.
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

    const [archived, variants] = await Promise.all([
      prisma.catalogEntry.findUnique({
        where: { workflowGroupId_audioHash: { workflowGroupId: catalogId, audioHash: hash } },
        select: { compressedPath: true, compressedAacPath: true },
      }),
      // Check for variants with listening audio
      prisma.workflowVariant.findMany({
        where: { workflowGroupId: catalogId },
        orderBy: [{ isDefault: "desc" }, { variant: "asc" }],
      }),
    ]);

    // Always have archived source
    sources.push({
      id: "archived",
      label: "Archived",
      type: "archived",
      available: true, // If we got here, archived exists
      formats: formatsFor(archived),
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
            select: { compressedPath: true, compressedAacPath: true },
          });
          return { variant, available: !!row, formats: formatsFor(row) };
        })
    );

    for (const item of listeningAvailability) {
      sources.push({
        id: `listening:${item.variant.variant}`,
        label: item.variant.label || `Listening (${item.variant.variant})`,
        type: "listening",
        variant: item.variant.variant,
        available: item.available,
        formats: item.formats,
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
