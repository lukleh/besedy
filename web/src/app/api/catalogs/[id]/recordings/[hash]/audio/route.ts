import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import prisma from "@/lib/db";
import { getCatalogEntry } from "@/lib/catalog";
import { AuthError } from "@/lib/auth/permissions";
import {
  logAudioStreamed,
  logAudioDownloaded,
  logAccessDenied,
  type AudioStreamRange,
} from "@/lib/audit/logger";
import {
  resolveCatalogRecordingRouteAccess,
  requireCatalogRecordingAccess,
  requireCatalogRecordingDownload,
} from "@/lib/access/catalog-recording-route-access";
import { createServerLogger } from "@/lib/log/server";
import { validatePathAsync, rewritePath } from "@/lib/security/path-validation";
import { AudioQuerySchema, CatalogHashParamSchema } from "@/lib/validation/schemas";
import { validateParams } from "@/lib/api";

// Force Node.js runtime for filesystem access
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const logger = createServerLogger();

// Content type mapping
const CONTENT_TYPES: Record<string, string> = {
  ".webm": "audio/webm",
  ".opus": "audio/opus",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
};

/**
 * Create Content-Disposition header value with proper encoding for non-ASCII filenames
 * Uses RFC 5987 encoding for UTF-8 filenames
 */
function getContentDisposition(filename: string): string {
  // ASCII-safe fallback filename
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_");
  // RFC 5987 encoded filename for UTF-8 support
  const encodedFilename = encodeURIComponent(filename).replace(/['()]/g, escape);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`;
}

interface AudioRouteLogContext {
  method: string;
  path: string;
  catalogId: string;
  hash: string;
  requestedSource: string | null;
  servedSource: string | null;
  variant: string | null;
  download: boolean | null;
  rangeHeader: string | null;
  userAgent: string | null;
}

function normalizeUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const maxLength = 256;
  if (userAgent.length <= maxLength) return userAgent;
  return `${userAgent.slice(0, maxLength - 3)}...`;
}

function buildAudioRouteLogContext(
  request: NextRequest,
  params: {
    catalogId: string;
    hash: string;
    requestedSource: string | null;
    servedSource: string | null;
    variant: string | null;
    download: boolean | null;
    rangeHeader: string | null;
  }
): AudioRouteLogContext {
  return {
    method: request.method,
    path: request.nextUrl.pathname,
    catalogId: params.catalogId,
    hash: params.hash,
    requestedSource: params.requestedSource,
    servedSource: params.servedSource,
    variant: params.variant,
    download: params.download,
    rangeHeader: params.rangeHeader,
    userAgent: normalizeUserAgent(request.headers.get("user-agent")),
  };
}

function logAudioRouteResponse(
  level: "info" | "warn" | "error",
  context: AudioRouteLogContext,
  params: {
    status: number;
    reason: string;
    handlerMs: number;
    fileSize?: number;
    responseBytes?: number;
    errorName?: string;
    errorMessage?: string;
  }
): void {
  logger.event(level, {
    event: "audio_route_response",
    ...context,
    ...params,
  });
}

function attachAudioStreamDiagnostics(
  request: NextRequest,
  stream: fs.ReadStream,
  context: AudioRouteLogContext,
  startedAtMs: number
): void {
  let streamEnded = false;

  const cleanup = () => {
    request.signal.removeEventListener("abort", handleAbort);
    stream.off("end", handleEnd);
    stream.off("close", cleanup);
    stream.off("error", handleError);
  };

  const handleEnd = () => {
    streamEnded = true;
  };

  const handleAbort = () => {
    if (streamEnded) return;

    logger.event("warn", {
      event: "audio_route_stream_abort",
      ...context,
      bytesRead: stream.bytesRead,
      elapsedMs: Date.now() - startedAtMs,
    });

    if (!stream.destroyed) {
      stream.destroy();
    }
  };

  const handleError = (error: Error) => {
    logger.event("error", {
      event: "audio_route_stream_error",
      ...context,
      bytesRead: stream.bytesRead,
      elapsedMs: Date.now() - startedAtMs,
      errorName: error.name,
      errorMessage: error.message,
    });
  };

  stream.on("end", handleEnd);
  stream.on("close", cleanup);
  stream.on("error", handleError);

  if (request.signal.aborted) {
    handleAbort();
    return;
  }

  request.signal.addEventListener("abort", handleAbort, { once: true });
}

/**
 * GET /api/catalogs/:id/recordings/:hash/audio - Stream audio file
 *
 * Supports HTTP Range requests for seeking.
 * Query params:
 * - source: Audio source - "archived" (default) or "listening"
 * - variant: Variant name when source=listening (uses default variant if not specified)
 * - download: If "true", force download instead of streaming
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; hash: string }> }
) {
  const requestStartedAt = Date.now();
  const { searchParams } = new URL(request.url);
  const rangeHeader = request.headers.get("range");
  let catalogId = "unknown";
  let hash = "unknown";
  let requestedSource: string | null = searchParams.get("source");
  let servedSource: string | null = requestedSource;
  let variantName: string | null = searchParams.get("variant");
  let forceDownload: boolean | null =
    searchParams.get("download") === "true"
      ? true
      : searchParams.get("download") === "false"
        ? false
        : null;
  const currentLogContext = () =>
    buildAudioRouteLogContext(request, {
      catalogId,
      hash,
      requestedSource,
      servedSource,
      variant: variantName,
      download: forceDownload,
      rangeHeader,
    });
  const logResponse = (
    level: "info" | "warn" | "error",
    status: number,
    reason: string,
    extra?: {
      fileSize?: number;
      responseBytes?: number;
      errorName?: string;
      errorMessage?: string;
    }
  ) =>
    logAudioRouteResponse(level, currentLogContext(), {
      status,
      reason,
      handlerMs: Date.now() - requestStartedAt,
      ...(extra ?? {}),
    });

  try {
    const rawParams = await params;
    if (typeof rawParams.id === "string") {
      catalogId = rawParams.id;
    }
    if (typeof rawParams.hash === "string") {
      hash = rawParams.hash;
    }

    const paramsResult = validateParams(rawParams, CatalogHashParamSchema);
    if (!paramsResult.success) {
      logResponse("warn", paramsResult.response.status, "invalid_route_params");
      return paramsResult.response;
    }
    ({ id: catalogId, hash } = paramsResult.data);

    // Validate query parameters
    const queryResult = AudioQuerySchema.safeParse({
      source: searchParams.get("source") ?? undefined,
      variant: searchParams.get("variant") ?? undefined,
      download: searchParams.get("download") ?? undefined,
    });
    if (!queryResult.success) {
      const response = NextResponse.json(
        { error: "Invalid query parameters", details: queryResult.error.flatten() },
        { status: 400 }
      );
      servedSource = null;
      logResponse("warn", response.status, "invalid_query_parameters");
      return response;
    }
    const audioSource = queryResult.data.source;
    requestedSource = audioSource;
    variantName = queryResult.data.variant ?? null;
    forceDownload = queryResult.data.download;
    servedSource = requestedSource;

    const access = await resolveCatalogRecordingRouteAccess(catalogId, hash);
    if (!access.ok) {
      logResponse("warn", access.response.status, "route_access_denied");
      return access.response;
    }
    const { userId } = access;

    const deniedRecordingResponse = await requireCatalogRecordingAccess(access, {
      auditResource: "audio",
      deniedMessage: "Access denied to this recording",
    });
    if (deniedRecordingResponse) {
      logResponse("warn", deniedRecordingResponse.status, "recording_access_denied");
      return deniedRecordingResponse;
    }

    if (forceDownload) {
      const deniedDownloadResponse = await requireCatalogRecordingDownload(access, {
        auditResource: "audio",
        deniedMessage: "Download not permitted for this recording",
      });
      if (deniedDownloadResponse) {
        logResponse("warn", deniedDownloadResponse.status, "download_access_denied");
        return deniedDownloadResponse;
      }
    }

    // Get catalog entry (paths derived from besedy.toml config)
    const entry = await getCatalogEntry(catalogId, hash);

    if (!entry) {
      const response = NextResponse.json(
        { error: "Recording not found" },
        { status: 404 }
      );
      logResponse("warn", response.status, "recording_not_found");
      return response;
    }

    if (!entry.isActionable) {
      const response = NextResponse.json(
        { error: "Recording not available (missing from one of the catalogs)" },
        { status: 404 }
      );
      logResponse("warn", response.status, "recording_not_actionable");
      return response;
    }

    // Determine audio path based on source
    let audioPath: string | undefined;
    let downloadFilename: string | undefined;

    if (audioSource === "original") {
      // Original audio file download
      audioPath = entry.originalPath;
      downloadFilename = audioPath ? path.basename(audioPath) : undefined;
    } else if (audioSource === "listening") {
      // Get variant for listening source
      const variant = await resolveVariant(catalogId, variantName);
      variantName = variant?.variant ?? variantName;
      if (variant?.listeningArchivedCatalogPath) {
        // Check DB-backed listening availability and resolve path
        const listeningPath = await getListeningAudioPath(
          catalogId,
          variant.variant,
          hash
        );
        if (listeningPath) {
          audioPath = listeningPath;
        }
      }
      // Fall back to archived if listening not available
      if (!audioPath) {
        audioPath = entry.compressedPath;
        servedSource = "archived";
      } else {
        servedSource = "listening";
      }
      downloadFilename = audioPath ? path.basename(audioPath) : undefined;
    } else {
      // Default: use archived path
      audioPath = entry.compressedPath;
      downloadFilename = audioPath ? path.basename(audioPath) : undefined;
    }

    if (!audioPath) {
      const response = NextResponse.json(
        { error: "No audio file path found" },
        { status: 404 }
      );
      logResponse("warn", response.status, "audio_path_missing");
      return response;
    }

    // Rewrite host paths to container paths (CSV catalogs contain host paths)
    audioPath = rewritePath(audioPath);

    // SECURITY: Validate path is within allowed directories
    const pathValidation = await validatePathAsync(audioPath);
    if (!pathValidation.valid) {
      console.error(
        `Path validation failed for audio: ${audioPath}`,
        pathValidation.reason
      );
      await logAccessDenied(userId, "audio", hash, {
        groupId: catalogId,
        reason: "Path outside allowed directories",
      });
      const response = NextResponse.json(
        { error: "Invalid audio path" },
        { status: 403 }
      );
      logResponse("warn", response.status, "audio_path_invalid");
      return response;
    }
    // Use the resolved (canonical) path for file operations
    const resolvedAudioPath = pathValidation.resolvedPath;

    // Check if file exists
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolvedAudioPath);
    } catch {
      const response = NextResponse.json(
        { error: "Audio file not found on disk" },
        { status: 404 }
      );
      logResponse("warn", response.status, "audio_file_missing");
      return response;
    }
    const fileSize = stat.size;

    // Determine content type
    const ext = path.extname(resolvedAudioPath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

    if (rangeHeader) {
      // Accept `bytes=N-`, `bytes=N-M`, and suffix ranges `bytes=-N`
      // (last N bytes), per RFC 9110 §14.1.2.
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      const hasStart = match?.[1] !== undefined && match[1] !== "";
      const hasEnd = match?.[2] !== undefined && match[2] !== "";
      if (match && (hasStart || hasEnd)) {
        let start: number;
        let end: number;

        if (!hasStart) {
          // Suffix range: last N bytes. Zero-length is not satisfiable.
          const suffixLength = parseInt(match[2], 10);
          if (suffixLength === 0) {
            const response = new NextResponse(null, {
              status: 416,
              headers: {
                "Content-Range": `bytes */${fileSize}`,
              },
            });
            logResponse("warn", response.status, "range_not_satisfiable", { fileSize });
            return response;
          }
          // If suffix exceeds the file, RFC says serve the whole file.
          start = Math.max(0, fileSize - suffixLength);
          end = fileSize - 1;
        } else {
          start = parseInt(match[1], 10);
          if (start >= fileSize) {
            const response = new NextResponse(null, {
              status: 416,
              headers: {
                "Content-Range": `bytes */${fileSize}`,
              },
            });
            logResponse("warn", response.status, "range_not_satisfiable", { fileSize });
            return response;
          }
          // Honor the requested range exactly. Truncating open-ended ranges to
          // an arbitrary chunk size depends on browser-specific follow-up
          // behavior and can stop playback early on some clients.
          const requestedEnd = hasEnd ? parseInt(match[2], 10) : fileSize - 1;
          end = Math.min(requestedEnd, fileSize - 1);
        }

        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(resolvedAudioPath, { start, end });

        // Log access for range requests with range info
        const range: AudioStreamRange = { start, end, fileSize };
        if (forceDownload) {
          await logAudioDownloaded(userId, hash, catalogId, audioSource);
        } else {
          await logAudioStreamed(userId, hash, catalogId, range);
        }

        const response = new NextResponse(stream as unknown as ReadableStream, {
          status: 206,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(chunkSize),
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            ...(forceDownload && downloadFilename && {
              "Content-Disposition": getContentDisposition(downloadFilename),
            }),
          },
        });
        attachAudioStreamDiagnostics(request, stream, currentLogContext(), requestStartedAt);
        logResponse("info", response.status, forceDownload ? "range_download" : "range_stream", {
          fileSize,
          responseBytes: chunkSize,
        });
        return response;
      }
    }

    // Full file request (no Range header)
    if (forceDownload) {
      // Downloads get the full file
      await logAudioDownloaded(userId, hash, catalogId, audioSource);
      const stream = fs.createReadStream(resolvedAudioPath);

      const response = new NextResponse(stream as unknown as ReadableStream, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(fileSize),
          "Accept-Ranges": "bytes",
          ...(downloadFilename && {
            "Content-Disposition": getContentDisposition(downloadFilename),
          }),
        },
      });
      attachAudioStreamDiagnostics(request, stream, currentLogContext(), requestStartedAt);
      logResponse("info", response.status, "full_download", {
        fileSize,
        responseBytes: fileSize,
      });
      return response;
    }

    // Without an explicit Range request, return a normal 200 streaming
    // response. Sending a synthetic first chunk as 206 is not reliably
    // interoperable across browsers and can truncate playback.
    const stream = fs.createReadStream(resolvedAudioPath);
    const range: AudioStreamRange = { start: 0, end: fileSize - 1, fileSize };
    await logAudioStreamed(userId, hash, catalogId, range);

    const response = new NextResponse(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
      },
    });
    attachAudioStreamDiagnostics(request, stream, currentLogContext(), requestStartedAt);
    logResponse("info", response.status, "full_stream", {
      fileSize,
      responseBytes: fileSize,
    });
    return response;
  } catch (error) {
    if (error instanceof AuthError) {
      const response = NextResponse.json({ error: error.message }, { status: error.statusCode });
      logResponse("warn", response.status, "auth_error");
      return response;
    }
    const response = NextResponse.json(
      { error: "Failed to stream audio" },
      { status: 500 }
    );
    logResponse("error", response.status, "stream_failed", {
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return response;
  }
}

/**
 * Resolve variant for listening audio
 */
async function resolveVariant(groupId: string, variantName?: string | null) {
  if (variantName) {
    return prisma.workflowVariant.findFirst({
      where: { workflowGroupId: groupId, variant: variantName },
    });
  }

  // Get default variant
  const defaultVariant = await prisma.workflowVariant.findFirst({
    where: { workflowGroupId: groupId, isDefault: true },
  });
  if (defaultVariant) return defaultVariant;

  // Get any variant
  return prisma.workflowVariant.findFirst({
    where: { workflowGroupId: groupId },
    orderBy: { variant: "asc" },
  });
}

/**
 * Get audio path from DB-backed listening catalog table
 */
async function getListeningAudioPath(
  groupId: string,
  variant: string,
  hash: string
): Promise<string | undefined> {
  const row = await prisma.catalogListeningEntry.findUnique({
    where: {
      workflowGroupId_variant_audioHash: {
        workflowGroupId: groupId,
        variant,
        audioHash: hash,
      },
    },
    select: { compressedPath: true },
  });
  return row?.compressedPath ?? undefined;
}
