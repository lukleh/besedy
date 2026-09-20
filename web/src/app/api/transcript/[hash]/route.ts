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
import {
  CORRECTED_TRANSCRIPT_BACKEND,
  isCorrectedTranscriptBackend,
} from "@/lib/correction/backend-key";
import { resolveReaderTranscriptSource } from "@/lib/correction/resolve";
import {
  getReaderCorrectionState,
  loadPublishedTranscript,
} from "@/lib/correction/reader-transcript";

export const dynamic = "force-dynamic";

/**
 * GET /api/transcript/:hash - Get transcript for a recording
 *
 * Query params:
 * - group: Optional group ID override
 * - backend: Transcript backend key ({workflow}/{model_component}), or
 *   `corrected/published` for the published corrected transcript
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

    // For a correction-eligible primary recording the machine text is not the
    // reader's transcript. The published correction is, and until one exists
    // this surface has no text to serve — only progress.
    const readerSource = await resolveReaderTranscriptSource(group.id, hash);
    const correctionPublished = readerSource.kind === "publication";

    const priorities = await listTranscriptBackendPriorities();
    const available = await getAvailableTranscripts(transcriptsPath, hash, {
      priorities,
    });
    const defaultMachineBackend = available.backends[0] ?? null;

    const defaultBackend = correctionPublished
      ? CORRECTED_TRANSCRIPT_BACKEND
      : readerSource.kind === "withheld"
        ? null
        : defaultMachineBackend;

    // Without the administrative view, there is one transcript: the default.
    // The alternatives are unevaluated machine output, so they are neither
    // listed nor servable, and hiding the picker alone would not achieve that.
    if (!backend) {
      const machineBackends = capability.canSeeTranscriptVariants
        ? available.backends
        : readerSource.kind === "machine" && defaultMachineBackend
          ? [defaultMachineBackend]
          : [];

      return NextResponse.json({
        hash,
        backends: correctionPublished
          ? [CORRECTED_TRANSCRIPT_BACKEND, ...machineBackends]
          : machineBackends,
        ...(readerSource.kind === "withheld"
          ? { correction: await getReaderCorrectionState(readerSource.workspaceId) }
          : {}),
      });
    }

    if (isCorrectedTranscriptBackend(backend)) {
      if (!correctionPublished) {
        return NextResponse.json(
          {
            error: "This transcript has not been published",
            code: "TRANSCRIPT_NOT_PUBLISHED",
            correction:
              readerSource.kind === "withheld"
                ? await getReaderCorrectionState(readerSource.workspaceId)
                : null,
          },
          { status: 404 }
        );
      }

      const published = await loadPublishedTranscript(group.id, hash, readerSource);
      if (!published) {
        return NextResponse.json(
          { error: "Published transcript artifact is missing" },
          { status: 404 }
        );
      }

      await logTranscriptViewed(userId, hash, group.id, backend);
      return NextResponse.json(published);
    }

    if (!capability.canSeeTranscriptVariants && backend !== defaultBackend) {
      if (readerSource.kind === "withheld") {
        return NextResponse.json(
          {
            error: "This transcript has not been published",
            code: "TRANSCRIPT_NOT_PUBLISHED",
            correction: await getReaderCorrectionState(readerSource.workspaceId),
          },
          { status: 404 }
        );
      }
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
