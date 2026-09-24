import { NextRequest, NextResponse } from "next/server";
import { readTranscriptFile, type TranscriptFormat } from "@/lib/transcript";
import {
  logOriginalTranscriptDownloaded,
  logTranscriptDownloaded,
} from "@/lib/audit/logger";
import { resolveTranscriptRouteAccess } from "@/lib/access/transcript-route-access";
import { isCorrectedTranscriptBackend } from "@/lib/correction/backend-key";
import {
  frozenSourcePath,
  resolveOriginalTranscriptSource,
  resolveReaderTranscriptSource,
} from "@/lib/correction/resolve";
import { readPublishedTranscriptFile } from "@/lib/correction/reader-transcript";
import { readTextFile } from "@/lib/correction/storage";
import { resolveConfiguredDefaultBackend } from "@/lib/correction/source";
import {
  HashSchema,
  TranscriptBackendSchema,
  TranscriptFormatSchema,
} from "@/lib/validation/schemas";

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

const CONTENT_TYPES: Record<TranscriptFormat, string> = {
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  srt: "text/srt; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
};

/**
 * GET /api/transcript/:hash/download - Download transcript file
 *
 * Query params:
 * - group: Optional group ID override
 * - backend: Transcript backend key ({workflow}/{model_component})
 * - format: Download format (json, txt, srt, vtt) - default: json
 * - original: `1` to take the machine text underneath, for the roles that run
 *   the archive. Taking it never starts or changes a correction workspace.
 *
 * Only returns formats that exist on disk (no on-the-fly conversion).
 * Use `just catalog export-transcripts` to generate sidecar files.
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
    if (!rawBackend) {
      return NextResponse.json(
        { error: "Missing backend parameter" },
        { status: 400 }
      );
    }
    const rawFormat = searchParams.get("format") || "json";

    // Validate backend
    const backendResult = TranscriptBackendSchema.safeParse(rawBackend);
    if (!backendResult.success) {
      return NextResponse.json(
        { error: `Invalid backend: ${rawBackend}` },
        { status: 400 }
      );
    }
    const backend = backendResult.data;

    // Validate format
    const formatResult = TranscriptFormatSchema.safeParse(rawFormat);
    if (!formatResult.success) {
      return NextResponse.json(
        { error: `Invalid format: ${rawFormat}` },
        { status: 400 }
      );
    }
    const format = formatResult.data;

    const access = await resolveTranscriptRouteAccess({
      groupOverride,
      hash,
      accessDeniedMessage: "Access denied to this transcript",
      requireDownload: true,
      auditResource: "transcript",
    });
    if (!access.ok) {
      return access.response;
    }
    const { userId, group, transcriptsPath, capability } = access;

    const wantsOriginal = searchParams.get("original") === "1";
    let result: { content: string; filename: string } | null = null;
    let originalSource: "machine" | "frozen" = "machine";

    if (wantsOriginal) {
      if (!capability.canDownloadOriginalTranscript) {
        return NextResponse.json(
          { error: "Original transcript download not permitted for this account" },
          { status: 403 }
        );
      }

      const original = await resolveOriginalTranscriptSource(group.id, hash);
      originalSource = original.kind === "frozen" ? "frozen" : "machine";
      if (original.kind === "frozen") {
        // Once correction has started this is always the frozen source, before
        // or after publication, so the original is the text the corrections
        // were actually made against.
        if (format !== "json") {
          return NextResponse.json(
            {
              error:
                "Only the JSON original is kept once correction has started; sidecars are rendered per publication",
            },
            { status: 404 }
          );
        }
        const content = await readTextFile(frozenSourcePath(group.id, original));
        result = content === null ? null : { content, filename: "transcript.json" };
      } else {
        const defaultBackend = await resolveConfiguredDefaultBackend(
          transcriptsPath,
          hash
        );
        result = defaultBackend
          ? await readTranscriptFile(transcriptsPath, hash, defaultBackend, format)
          : null;
      }
    } else if (isCorrectedTranscriptBackend(backend)) {
      const readerSource = await resolveReaderTranscriptSource(group.id, hash);
      if (readerSource.kind !== "publication") {
        return NextResponse.json(
          {
            error: "This transcript has not been published",
            code: "TRANSCRIPT_NOT_PUBLISHED",
          },
          { status: 404 }
        );
      }
      result = await readPublishedTranscriptFile(group.id, readerSource, format);
    } else {
      // An ordinary transcript download carries what the reader can read. For a
      // correction-eligible recording that is the active publication, never the
      // machine text underneath it.
      const readerSource = await resolveReaderTranscriptSource(group.id, hash);
      if (readerSource.kind !== "machine" && !capability.canSeeTranscriptVariants) {
        return NextResponse.json(
          {
            error: "This transcript has not been published",
            code: "TRANSCRIPT_NOT_PUBLISHED",
          },
          { status: 404 }
        );
      }
      result = await readTranscriptFile(transcriptsPath, hash, backend, format);
    }

    if (!result) {
      return NextResponse.json(
        {
          error: `Format '${format}' not available for backend '${backend}'. Run 'just catalog export-transcripts' to generate sidecar files.`,
        },
        { status: 404 }
      );
    }

    // Log download
    if (wantsOriginal) {
      await logOriginalTranscriptDownloaded(userId, hash, group.id, {
        source: originalSource,
        backend,
        format,
      });
    } else {
      await logTranscriptDownloaded(userId, hash, group.id, backend, format);
    }

    // Return file content
    const safeBackend = (wantsOriginal ? `${backend}_original` : backend).replace(
      /[\\/]/g,
      "_"
    );
    const downloadFilename = `${hash.slice(0, 12)}_${safeBackend}.${format}`;

    return new NextResponse(result.content, {
      headers: {
        "Content-Type": CONTENT_TYPES[format],
        "Content-Disposition": `attachment; filename="${downloadFilename}"`,
      },
    });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error downloading transcript:", error);
    return NextResponse.json(
      { error: "Failed to download transcript" },
      { status: 500 }
    );
  }
}
