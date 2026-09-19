import { NextRequest, NextResponse } from "next/server";
import {
  getAvailableTranscripts,
  loadTranscript,
  type TranscriptBackend,
} from "@/lib/transcript";
import { listTranscriptBackendPriorities } from "@/lib/transcript-priority";
import { AuthError } from "@/lib/auth/permissions";
import { logTranscriptViewed } from "@/lib/audit/logger";
import { resolveTranscriptRouteAccess } from "@/lib/access/transcript-route-access";
import { HashSchema, TranscriptBackendSchema } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

/**
 * GET /api/transcript/:hash - Get transcript for a recording
 *
 * Query params:
 * - group: Optional group ID override
 * - backend: Transcript backend key ({workflow}/{model_component})
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string }> }
) {
  try {
    const { hash: rawHash } = await params;

    // Validate hash format
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

    // Validate backend if provided
    let backend: TranscriptBackend | null = null;
    if (rawBackend) {
      const backendResult = TranscriptBackendSchema.safeParse(rawBackend);
      if (!backendResult.success) {
        return NextResponse.json(
          { error: `Invalid backend: ${rawBackend}` },
          { status: 400 }
        );
      }
      backend = backendResult.data;
    }

    const access = await resolveTranscriptRouteAccess({
      groupOverride,
      hash,
      accessDeniedMessage: "Access denied to this transcript",
      auditResource: "transcript",
    });
    if (!access.ok) {
      return access.response;
    }
    const { userId, group, transcriptsPath, capability } = access;

    const priorities = await listTranscriptBackendPriorities();
    const available = await getAvailableTranscripts(transcriptsPath, hash, {
      priorities,
    });
    // Ordered by configured priority, so the first is the default one.
    const defaultBackend = available.backends[0] ?? null;

    // Without the administrative view, there is one transcript: the default.
    // The alternatives are unevaluated machine output, so they are neither
    // listed nor servable, and hiding the picker alone would not achieve that.
    if (!backend) {
      return NextResponse.json(
        capability.canSeeTranscriptVariants || defaultBackend === null
          ? available
          : { ...available, backends: [defaultBackend] }
      );
    }

    if (!capability.canSeeTranscriptVariants && backend !== defaultBackend) {
      return NextResponse.json(
        { error: "Only the default transcript is available for this account" },
        { status: 403 }
      );
    }

    // Load transcript
    const transcript = await loadTranscript(transcriptsPath, hash, backend);

    if (!transcript) {
      return NextResponse.json(
        { error: `Transcript not found for backend: ${backend}` },
        { status: 404 }
      );
    }

    // Log transcript access
    await logTranscriptViewed(userId, hash, group.id, backend);

    // Some transcripts carry a speaker on each segment, which is the same
    // disclosure the overlay makes, reached by a different route.
    if (!capability.canSeeSpeakers) {
      return NextResponse.json({
        ...transcript,
        segments: transcript.segments.map((segment) => {
          const withoutSpeaker = { ...segment };
          delete withoutSpeaker.speaker;
          return withoutSpeaker;
        }),
      });
    }

    return NextResponse.json(transcript);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error loading transcript:", error);
    return NextResponse.json(
      { error: "Failed to load transcript" },
      { status: 500 }
    );
  }
}
