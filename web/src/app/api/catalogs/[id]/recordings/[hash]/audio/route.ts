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
  requireCatalogRecordingOriginalAudio,
} from "@/lib/access/catalog-recording-route-access";
import { createServerLogger } from "@/lib/log/server";
import { validatePathAsync, rewritePath } from "@/lib/security/path-validation";
import { AudioQuerySchema, CatalogHashParamSchema } from "@/lib/validation/schemas";
import { validateParams } from "@/lib/api";
import { checkReadableFile, openReadStream } from "@/lib/readable-file";

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
  format: string | null;
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
    format: string | null;
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
    format: params.format,
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
    errorCode?: string;
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
 * Open the audio file, wrap it in the response, and attach the stream
 * diagnostics, all in the same tick so an open error always has a listener
 * (see openReadStream). The response is built first because the diagnostics
 * destroy the stream at once for an already-aborted request.
 */
function createAudioStreamResponse(
  request: NextRequest,
  filePath: string,
  options: { start?: number; end?: number } | undefined,
  init: ResponseInit,
  context: AudioRouteLogContext,
  startedAtMs: number
): NextResponse {
  return openReadStream(filePath, options, (stream) => {
    const response = new NextResponse(stream as unknown as ReadableStream, init);
    attachAudioStreamDiagnostics(request, stream, context, startedAtMs);
    return response;
  });
}

/**
 * GET /api/catalogs/:id/recordings/:hash/audio - Stream audio file
 *
 * Supports HTTP Range requests for seeking.
 * Query params:
 * - source: Audio source - "archived" (default) or "listening"
 * - variant: Variant name when source=listening (uses default variant if not specified)
 * - format: "webm" (default) or "aac", the AAC-in-MP4 copy of the resolved
 *   source. There is no fallback to WebM: iOS Safari cannot stream it, so a
 *   missing copy is a 404 and the client picks another source or format.
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
  let audioFormat: string | null = searchParams.get("format");
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
      format: audioFormat,
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
      errorCode?: string;
      errorMessage?: string;
    }
  ) =>
    logAudioRouteResponse(level, currentLogContext(), {
      status,
      reason,
      handlerMs: Date.now() - requestStartedAt,
      ...(extra ?? {}),
    });
  const rangeNotSatisfiable = (fileSize: number) => {
    const response = new NextResponse(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${fileSize}`,
      },
    });
    logResponse("warn", response.status, "range_not_satisfiable", { fileSize });
    return response;
  };

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
      format: searchParams.get("format") ?? undefined,
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
    const audioSourceParam = audioSource;
    requestedSource = audioSource;
    variantName = queryResult.data.variant ?? null;
    forceDownload = queryResult.data.download;
    servedSource = requestedSource;
    const wantsAac = queryResult.data.format === "aac";
    audioFormat = queryResult.data.format;

    // The master is kept as it was recorded; only archives have an AAC copy.
    if (wantsAac && audioSource === "original") {
      const response = NextResponse.json(
        { error: "The original recording has no AAC copy" },
        { status: 400 }
      );
      logResponse("warn", response.status, "aac_original_unsupported");
      return response;
    }

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

    // The master is not what anyone is offered. No role carries it, so this is
    // the catalog administrator holding every permission -- and it is asked
    // whether or not the request forces a download, because serving the master
    // inline would deliver the same bytes.
    if (audioSourceParam === "original" && !access.capability.canDownloadOriginalAudio) {
      const denied = await requireCatalogRecordingOriginalAudio(access, {
        auditResource: "audio",
        deniedMessage: "The original recording is not available for this account",
      });
      if (denied) {
        logResponse("warn", denied.status, "original_audio_access_denied");
        return denied;
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
      const listening = variant?.listeningArchivedCatalogPath
        ? // Check DB-backed listening availability and resolve path
          await getListeningAudioPaths(catalogId, variant.variant, hash)
        : undefined;
      // Fall back to archived if listening not available
      servedSource = listening ? "listening" : "archived";
      audioPath = pickFormat(listening ?? entry, wantsAac);
      downloadFilename = audioPath ? path.basename(audioPath) : undefined;
    } else {
      // Default: use archived path
      audioPath = pickFormat(entry, wantsAac);
      downloadFilename = audioPath ? path.basename(audioPath) : undefined;
    }

    // Audit records keep their old shape for the default WebM.
    const auditFormat = wantsAac ? "aac" : undefined;

    if (!audioPath && wantsAac) {
      const response = NextResponse.json(
        { error: "No AAC copy for this recording" },
        { status: 404 }
      );
      logResponse("warn", response.status, "aac_unavailable");
      return response;
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

    // Check that the path is a regular file this process can read. stat()
    // succeeds on an unreadable file and on a directory, and the read stream
    // would only fail after the response has been built.
    const fileCheck = await checkReadableFile(resolvedAudioPath);
    if (!fileCheck.ok) {
      if (fileCheck.reason === "missing") {
        const response = NextResponse.json(
          { error: "Audio file not found on disk" },
          { status: 404 }
        );
        logResponse("warn", response.status, "audio_file_missing", {
          errorCode: fileCheck.code,
        });
        return response;
      }
      const response = NextResponse.json(
        { error: "Audio file is not readable" },
        { status: 500 }
      );
      const { error } = fileCheck;
      logResponse(
        "error",
        response.status,
        fileCheck.reason === "not_a_file" ? "audio_file_not_regular" : "audio_file_unreadable",
        {
          errorName: error instanceof Error ? error.name : undefined,
          errorCode: fileCheck.code,
          errorMessage: error instanceof Error ? error.message : undefined,
        }
      );
      return response;
    }
    const fileSize = fileCheck.stat.size;

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
            return rangeNotSatisfiable(fileSize);
          }
          // If suffix exceeds the file, RFC says serve the whole file.
          start = Math.max(0, fileSize - suffixLength);
          end = fileSize - 1;
        } else {
          start = parseInt(match[1], 10);
          if (start >= fileSize) {
            return rangeNotSatisfiable(fileSize);
          }
          // Honor the requested range exactly. Truncating open-ended ranges to
          // an arbitrary chunk size depends on browser-specific follow-up
          // behavior and can stop playback early on some clients.
          const requestedEnd = hasEnd ? parseInt(match[2], 10) : fileSize - 1;
          end = Math.min(requestedEnd, fileSize - 1);
        }

        // An inverted range (`bytes=100-50`) or a suffix range on an empty
        // file leaves end < start, which createReadStream rejects.
        if (end < start) {
          return rangeNotSatisfiable(fileSize);
        }

        const chunkSize = end - start + 1;

        // Log access for range requests with range info. Write the audit entry
        // before opening the file so a failed audit write leaves no descriptor
        // open.
        const range: AudioStreamRange = { start, end, fileSize };
        if (forceDownload) {
          await logAudioDownloaded(userId, hash, catalogId, audioSource, auditFormat);
        } else {
          await logAudioStreamed(userId, hash, catalogId, range, auditFormat);
        }

        const response = createAudioStreamResponse(
          request,
          resolvedAudioPath,
          { start, end },
          {
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
          },
          currentLogContext(),
          requestStartedAt
        );
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
      await logAudioDownloaded(userId, hash, catalogId, audioSource, auditFormat);
      const response = createAudioStreamResponse(
        request,
        resolvedAudioPath,
        undefined,
        {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(fileSize),
            "Accept-Ranges": "bytes",
            ...(downloadFilename && {
              "Content-Disposition": getContentDisposition(downloadFilename),
            }),
          },
        },
        currentLogContext(),
        requestStartedAt
      );
      logResponse("info", response.status, "full_download", {
        fileSize,
        responseBytes: fileSize,
      });
      return response;
    }

    // Without an explicit Range request, return a normal 200 streaming
    // response. Sending a synthetic first chunk as 206 is not reliably
    // interoperable across browsers and can truncate playback.
    const range: AudioStreamRange = { start: 0, end: fileSize - 1, fileSize };
    await logAudioStreamed(userId, hash, catalogId, range, auditFormat);

    const response = createAudioStreamResponse(
      request,
      resolvedAudioPath,
      undefined,
      {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(fileSize),
          "Accept-Ranges": "bytes",
        },
      },
      currentLogContext(),
      requestStartedAt
    );
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

/** The file for the requested format: the AAC-in-MP4 copy or the WebM. */
function pickFormat(
  paths: { compressedPath?: string | null; compressedAacPath?: string | null },
  wantsAac: boolean
): string | undefined {
  return (wantsAac ? paths.compressedAacPath : paths.compressedPath) ?? undefined;
}

/**
 * Get the variant's audio paths from the DB-backed listening catalog table,
 * or undefined when the variant has no row for this recording.
 */
async function getListeningAudioPaths(
  groupId: string,
  variant: string,
  hash: string
): Promise<{ compressedPath: string; compressedAacPath: string | undefined } | undefined> {
  const row = await prisma.catalogListeningEntry.findUnique({
    where: {
      workflowGroupId_variant_audioHash: {
        workflowGroupId: groupId,
        variant,
        audioHash: hash,
      },
    },
    select: { compressedPath: true, compressedAacPath: true },
  });
  if (!row?.compressedPath) return undefined;
  return {
    compressedPath: row.compressedPath,
    compressedAacPath: row.compressedAacPath ?? undefined,
  };
}
