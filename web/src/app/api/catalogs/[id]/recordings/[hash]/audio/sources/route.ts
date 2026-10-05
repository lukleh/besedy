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
  type: "archived";
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
 * Returns the available audio sources (the archived recording), each with
 * the formats it can be served in.
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

    const archived = await prisma.catalogEntry.findUnique({
      where: { workflowGroupId_audioHash: { workflowGroupId: catalogId, audioHash: hash } },
      select: { compressedPath: true, compressedAacPath: true },
    });

    // Always listed; available when it has a file the audio route can serve.
    const archivedFormats = formatsFor(archived);
    sources.push({
      id: "archived",
      label: "Archived",
      type: "archived",
      available: archivedFormats.length > 0,
      formats: archivedFormats,
    });

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
