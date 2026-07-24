import { NextRequest, NextResponse } from "next/server";
import {
  getAvailableDiarizations,
  loadDiarization,
  DiarizationBackend,
} from "@/lib/transcript";
import { resolveTranscriptRouteAccess } from "@/lib/access/transcript-route-access";
import { HashSchema } from "@/lib/validation/schemas";

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
 * GET /api/transcript/:hash/speakers - Get speaker diarization for a recording
 *
 * Query params:
 * - group: Optional group ID override
 * - backend: Diarization backend (pyannote)
 *
 * Without backend param: returns available diarization backends
 * With backend param: returns diarization data for that backend
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
    const backend = searchParams.get("backend") as DiarizationBackend | null;

    const access = await resolveTranscriptRouteAccess({
      groupOverride,
      hash,
      accessDeniedMessage: "Access denied to this recording",
      auditResource: "speakers",
    });
    if (!access.ok) {
      return access.response;
    }
    const { transcriptsPath } = access;

    // If no backend specified, return available backends
    if (!backend) {
      const available = await getAvailableDiarizations(transcriptsPath, hash);
      return NextResponse.json({ hash, backends: available });
    }

    // Validate backend
    const validBackends: DiarizationBackend[] = ["pyannote"];
    if (!validBackends.includes(backend)) {
      return NextResponse.json(
        { error: `Invalid backend: ${backend}. Only 'pyannote' is supported.` },
        { status: 400 }
      );
    }

    // Load diarization
    const diarization = await loadDiarization(transcriptsPath, hash, backend);

    if (!diarization) {
      return NextResponse.json(
        { error: `Diarization not found for backend: ${backend}` },
        { status: 404 }
      );
    }

    return NextResponse.json(diarization);
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error loading diarization:", error);
    return NextResponse.json(
      { error: "Failed to load diarization" },
      { status: 500 }
    );
  }
}
