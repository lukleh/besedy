import { NextRequest, NextResponse } from "next/server";
import { getAvailableFormats, type TranscriptBackend } from "@/lib/transcript";
import { resolveTranscriptRouteAccess } from "@/lib/access/transcript-route-access";
import { HashSchema, TranscriptBackendSchema } from "@/lib/validation/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
 * GET /api/transcript/:hash/formats - Get available download formats
 *
 * Query params:
 * - group: Optional group ID override
 * - backend: Transcript backend key ({workflow}/{model_component})
 *
 * Returns list of formats available on disk for this transcript.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string }> }
) {
  try {
    const { hash: rawHash } = await params;

    const hashResult = HashSchema.safeParse(rawHash);
    if (!hashResult.success) {
      return NextResponse.json(
        { error: "Invalid hash format" },
        { status: 400 }
      );
    }
    const hash = hashResult.data;
    const { searchParams } = new URL(request.url);
    const groupOverride = searchParams.get("group");
    const rawBackend = searchParams.get("backend");
    if (!rawBackend) {
      return NextResponse.json(
        { error: "Missing backend parameter" },
        { status: 400 }
      );
    }
    const backendResult = TranscriptBackendSchema.safeParse(rawBackend);
    if (!backendResult.success) {
      return NextResponse.json(
        { error: `Invalid backend: ${rawBackend}` },
        { status: 400 }
      );
    }
    const backend = backendResult.data as TranscriptBackend;

    const access = await resolveTranscriptRouteAccess({
      groupOverride,
      hash,
      accessDeniedMessage: "Access denied to this transcript",
    });
    if (!access.ok) {
      return access.response;
    }
    const { transcriptsPath, capability } = access;

    // Get available formats
    const result = await getAvailableFormats(transcriptsPath, hash, backend);

    if (!result) {
      return NextResponse.json(
        { error: `Transcript not found for backend: ${backend}` },
        { status: 404 }
      );
    }

    return NextResponse.json({
      hash,
      backend,
      formats: result.formats,
      canDownload: capability.canDownloadRecording,
    });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error getting transcript formats:", error);
    return NextResponse.json(
      { error: "Failed to get transcript formats" },
      { status: 500 }
    );
  }
}
