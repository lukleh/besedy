import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import sharp from "sharp";
import prisma from "@/lib/db";
import { requireCatalogManagementAccess } from "@/lib/access/catalog-management-route-access";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { IntIdSchema, validateParams } from "@/lib/api/validation";
import {
  findPosterFile,
  getPosterContentType,
  POSTER_EXTENSIONS,
  removeExistingPosterFiles,
  resolveEventPosterDir,
  type PosterExtension,
  writePosterMeta,
} from "@/lib/event-posters";
import { requiresReleasedEventVisibilityScope } from "@/lib/policy/event";
import { validatePath } from "@/lib/security/path-validation";
import { TimestampIdSchema } from "@/lib/validation/schemas";
import { isPublishedVisibleEvent } from "@/lib/catalog-events/visibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PosterVariantSchema = z.enum(["portrait", "landscape"]);
type PosterVariant = z.infer<typeof PosterVariantSchema>;
const POSTER_META_FILENAME = "poster_meta.json";
const MAX_UPLOAD_BYTES = 30 * 1000 * 1000;
// Accommodate common 48 MP phone photos while bounding decode work.
const MAX_INPUT_MEGAPIXELS = 50;
const MAX_INPUT_PIXELS = MAX_INPUT_MEGAPIXELS * 1_000_000;

type PosterUploadErrorCode =
  | "UPLOAD_TOO_LARGE"
  | "UPLOAD_PARSE_FAILED"
  | "INVALID_FILE"
  | "INVALID_FILE_TYPE"
  | "EMPTY_FILE";

interface PosterMetaEntry {
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  size: number;
}

interface ProcessedPoster {
  buffer: Buffer;
  size: number;
  mimeType: string;
}

type PosterMetaRecord = {
  portrait?: PosterMetaEntry;
  landscape?: PosterMetaEntry;
};

interface RouteParams {
  params: Promise<{ id: string; eventId: string }>;
}

const CatalogEventParamSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
});

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

function isFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value
  );
}

function isPosterExtension(value: string): value is PosterExtension {
  return POSTER_EXTENSIONS.some((extension) => extension === value);
}

function getPosterExtension(file: File): PosterExtension | null {
  const ext = path.extname(file.name).toLowerCase();
  if (isPosterExtension(ext)) return ext;
  if (file.type === "image/jpeg") return ".jpg";
  if (file.type === "image/png") return ".png";
  return null;
}

type PosterFormat = "jpeg" | "png";

function getPosterFormat(ext: PosterExtension): PosterFormat {
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "jpeg";
    case ".png":
      return "png";
    default: {
      const unsupportedExtension: never = ext;
      throw new Error(`Unsupported poster extension: ${unsupportedExtension}`);
    }
  }
}

const MIN_COMPRESS_BYTES = 1.5 * 1024 * 1024; // 1.5MB
const JPEG_BYTES_PER_PIXEL = 0.7;
const PNG_BYTES_PER_PIXEL = 1.2;

const MAX_DIMENSION = {
  portrait: 1600,
  landscape: 2400,
};

async function processPosterFile(
  file: File,
  ext: PosterExtension,
  variant: PosterVariant
): Promise<ProcessedPoster> {
  const inputBuffer = Buffer.from(await file.arrayBuffer());
  const format = getPosterFormat(ext);
  const mimeType = format === "png" ? "image/png" : "image/jpeg";

  // Make the strictness and resource budget explicit for untrusted uploads.
  // metadata() only reads headers; unchanged inputs need an explicit stats()
  // call below, while recompressed inputs are fully decoded by toBuffer().
  const image = sharp(inputBuffer, {
    failOn: "warning",
    limitInputPixels: MAX_INPUT_PIXELS,
  }).rotate();
  const metadata = await image.metadata();
  if (metadata.format !== format) {
    throw new Error("Poster image data does not match its JPG or PNG extension");
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const pixelCount = width * height;
  const bytesPerPixel = pixelCount > 0 ? inputBuffer.length / pixelCount : 0;
  const bppLimit = format === "png" ? PNG_BYTES_PER_PIXEL : JPEG_BYTES_PER_PIXEL;
  const maxDimension = MAX_DIMENSION[variant];
  const exceedsMaxDimension = width > maxDimension || height > maxDimension;

  const shouldCompress =
    exceedsMaxDimension ||
    (inputBuffer.length >= MIN_COMPRESS_BYTES && bytesPerPixel > bppLimit);

  if (!shouldCompress) {
    await image.clone().stats();
    return {
      buffer: inputBuffer,
      size: inputBuffer.length,
      mimeType,
    };
  }

  const pipeline = image.resize({
    width: maxDimension,
    height: maxDimension,
    fit: "inside",
    withoutEnlargement: true,
  });

  let outputBuffer: Buffer;
  switch (format) {
    case "png":
      outputBuffer = await pipeline
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
      break;
    case "jpeg":
      outputBuffer = await pipeline
        .jpeg({
          quality: 84,
          mozjpeg: true,
          chromaSubsampling: "4:2:0",
        })
        .toBuffer();
      break;
    default: {
      const unsupportedFormat: never = format;
      throw new Error(`Unsupported poster format: ${unsupportedFormat}`);
    }
  }

  if (
    outputBuffer.length > 0 &&
    (exceedsMaxDimension || outputBuffer.length <= inputBuffer.length)
  ) {
    return {
      buffer: outputBuffer,
      size: outputBuffer.length,
      mimeType,
    };
  }

  return {
    buffer: inputBuffer,
    size: inputBuffer.length,
    mimeType,
  };
}

async function readPosterMetaFile(dir: string): Promise<PosterMetaRecord | null> {
  try {
    const raw = await fs.readFile(path.join(dir, POSTER_META_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as PosterMetaRecord | null;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as PosterMetaRecord;
  } catch {
    return null;
  }
}

async function requireEvent(catalogId: string, eventId: number): Promise<boolean> {
  const event = await prisma.catalogEvent.findFirst({
    where: { id: eventId, workflowGroupId: catalogId },
    select: { id: true },
  });
  return !!event;
}

/**
 * GET /api/catalogs/:id/events/:eventId/poster - Fetch poster image
 *
 * Query params:
 * - variant: "portrait" | "landscape"
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogEventParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;

    const { searchParams } = new URL(request.url);
    const variant = PosterVariantSchema.safeParse(searchParams.get("variant"));
    if (!variant.success) {
      return NextResponse.json({ error: "Invalid poster variant" }, { status: 400 });
    }

    const { accessLevel } = await requireCatalogEventsAccess(catalogId, "view");

    if (requiresReleasedEventVisibilityScope(accessLevel)) {
      const isVisible = await isPublishedVisibleEvent(prisma, catalogId, eventId);
      if (!isVisible) {
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
    }

    const eventExists = await requireEvent(catalogId, eventId);
    if (!eventExists) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const posterPath = await findPosterFile(catalogId, eventId, variant.data);
    if (!posterPath) {
      return NextResponse.json({ error: "Poster not found" }, { status: 404 });
    }

    const pathValidation = validatePath(posterPath);
    if (!pathValidation.valid) {
      return NextResponse.json({ error: "Invalid poster path" }, { status: 403 });
    }

    const file = await fs.readFile(pathValidation.resolvedPath);
    return new NextResponse(file, {
      status: 200,
      headers: {
        "Content-Type": getPosterContentType(pathValidation.resolvedPath),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error fetching event poster:", error);
    return NextResponse.json({ error: "Failed to fetch poster" }, { status: 500 });
  }
}

/**
 * POST /api/catalogs/:id/events/:eventId/poster - Upload posters
 *
 * Multipart form fields:
 * - portrait: optional File
 * - landscape: optional File
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_BYTES * 2 + 2048) {
      return NextResponse.json(
        {
          error: "Upload too large",
          code: "UPLOAD_TOO_LARGE" satisfies PosterUploadErrorCode,
        },
        { status: 413 }
      );
    }

    const paramsResult = validateParams(await params, CatalogEventParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;

    const { userId } = await requireCatalogEventsAccess(catalogId, "view");
    const access = await requireCatalogManagementAccess(catalogId, {
      userId,
      auditResource: "event_poster",
      auditResourceId: String(eventId),
      deniedMessage: "Access denied to this poster",
      deniedReason: "Not owner/admin",
    });
    if (!access.ok) {
      return access.response;
    }

    const eventExists = await requireEvent(catalogId, eventId);
    if (!eventExists) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch (error) {
      console.warn("Failed to parse event poster upload form data:", error);
      return NextResponse.json(
        {
          error: "Unable to read poster upload",
          code: "UPLOAD_PARSE_FAILED" satisfies PosterUploadErrorCode,
        },
        { status: 400 }
      );
    }

    const portraitValue = formData.get("portrait");
    const landscapeValue = formData.get("landscape");

    const portraitFile = isFile(portraitValue) ? portraitValue : null;
    const landscapeFile = isFile(landscapeValue) ? landscapeValue : null;

    if (!portraitFile && !landscapeFile) {
      return NextResponse.json(
        { error: "At least one poster file is required" },
        { status: 400 }
      );
    }

    if ((portraitValue && !portraitFile) || (landscapeValue && !landscapeFile)) {
      return NextResponse.json(
        {
          error: "Invalid file upload",
          code: "INVALID_FILE" satisfies PosterUploadErrorCode,
        },
        { status: 400 }
      );
    }

    if (portraitFile && portraitFile.size === 0) {
      return NextResponse.json(
        {
          error: "Poster files cannot be empty",
          code: "EMPTY_FILE" satisfies PosterUploadErrorCode,
        },
        { status: 400 }
      );
    }
    if (landscapeFile && landscapeFile.size === 0) {
      return NextResponse.json(
        {
          error: "Poster files cannot be empty",
          code: "EMPTY_FILE" satisfies PosterUploadErrorCode,
        },
        { status: 400 }
      );
    }

    const portraitExt = portraitFile ? getPosterExtension(portraitFile) : null;
    const landscapeExt = landscapeFile ? getPosterExtension(landscapeFile) : null;
    if ((portraitFile && !portraitExt) || (landscapeFile && !landscapeExt)) {
      return NextResponse.json(
        {
          error: "Poster files must be JPG or PNG",
          code: "INVALID_FILE_TYPE" satisfies PosterUploadErrorCode,
        },
        { status: 400 }
      );
    }

    if ((portraitFile && portraitFile.size > MAX_UPLOAD_BYTES) || (landscapeFile && landscapeFile.size > MAX_UPLOAD_BYTES)) {
      return NextResponse.json(
        {
          error: "Upload too large",
          code: "UPLOAD_TOO_LARGE" satisfies PosterUploadErrorCode,
          maxBytes: MAX_UPLOAD_BYTES,
        },
        { status: 413 }
      );
    }

    const posterDir = resolveEventPosterDir(catalogId, eventId);
    await fs.mkdir(posterDir, { recursive: true });

    const dirValidation = validatePath(posterDir);
    if (!dirValidation.valid) {
      return NextResponse.json({ error: "Invalid poster directory" }, { status: 403 });
    }

    let processedPortrait: ProcessedPoster | null;
    let processedLandscape: ProcessedPoster | null;
    try {
      // Decode variants sequentially to bound peak memory use for one request.
      processedPortrait =
        portraitFile && portraitExt
          ? await processPosterFile(portraitFile, portraitExt, "portrait")
          : null;
      processedLandscape =
        landscapeFile && landscapeExt
          ? await processPosterFile(landscapeFile, landscapeExt, "landscape")
          : null;
    } catch (error) {
      console.warn("Rejected invalid event poster upload:", error);
      return NextResponse.json(
        {
          error:
            `Poster files must contain valid JPG or PNG image data and not exceed ` +
            `${MAX_INPUT_MEGAPIXELS} megapixels`,
          code: "INVALID_FILE" satisfies PosterUploadErrorCode,
        },
        { status: 400 }
      );
    }

    if (processedPortrait && portraitExt) {
      await removeExistingPosterFiles(dirValidation.resolvedPath, "portrait");
      const targetPath = path.join(
        dirValidation.resolvedPath,
        `poster_portrait${portraitExt}`
      );
      await fs.writeFile(targetPath, processedPortrait.buffer);
    }

    if (processedLandscape && landscapeExt) {
      await removeExistingPosterFiles(dirValidation.resolvedPath, "landscape");
      const targetPath = path.join(
        dirValidation.resolvedPath,
        `poster_landscape${landscapeExt}`
      );
      await fs.writeFile(targetPath, processedLandscape.buffer);
    }

    const existingMeta = await readPosterMetaFile(dirValidation.resolvedPath);
    const nextMeta: PosterMetaRecord = {
      ...(existingMeta ?? {}),
    };

    const nowIso = new Date().toISOString();
    if (processedPortrait && portraitFile) {
      nextMeta.portrait = {
        originalName: portraitFile.name,
        mimeType: processedPortrait.mimeType,
        uploadedAt: nowIso,
        size: processedPortrait.size,
      };
    }
    if (processedLandscape && landscapeFile) {
      nextMeta.landscape = {
        originalName: landscapeFile.name,
        mimeType: processedLandscape.mimeType,
        uploadedAt: nowIso,
        size: processedLandscape.size,
      };
    }

    await writePosterMeta(dirValidation.resolvedPath, nextMeta);

    return NextResponse.json({
      portrait: !!portraitFile,
      landscape: !!landscapeFile,
      warnings: [],
    });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error uploading event poster:", error);
    return NextResponse.json({ error: "Failed to upload poster" }, { status: 500 });
  }
}

/**
 * DELETE /api/catalogs/:id/events/:eventId/poster - Delete a poster variant
 *
 * Query params:
 * - variant: "portrait" | "landscape"
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogEventParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;

    const { searchParams } = new URL(request.url);
    const variant = PosterVariantSchema.safeParse(searchParams.get("variant"));
    if (!variant.success) {
      return NextResponse.json({ error: "Invalid poster variant" }, { status: 400 });
    }

    const { userId } = await requireCatalogEventsAccess(catalogId, "view");
    const access = await requireCatalogManagementAccess(catalogId, {
      userId,
      auditResource: "event_poster",
      auditResourceId: String(eventId),
      deniedMessage: "Access denied to this poster",
      deniedReason: "Not owner/admin",
    });
    if (!access.ok) {
      return access.response;
    }

    const eventExists = await requireEvent(catalogId, eventId);
    if (!eventExists) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const posterDir = resolveEventPosterDir(catalogId, eventId);
    const dirValidation = validatePath(posterDir);
    if (!dirValidation.valid) {
      return NextResponse.json({ error: "Invalid poster directory" }, { status: 403 });
    }

    const existing = await findPosterFile(catalogId, eventId, variant.data);
    if (!existing) {
      return NextResponse.json({ removed: false, variant: variant.data });
    }

    await removeExistingPosterFiles(dirValidation.resolvedPath, variant.data);

    const meta = await readPosterMetaFile(dirValidation.resolvedPath);
    if (meta) {
      const nextMeta: PosterMetaRecord = {};
      if (variant.data !== "portrait" && meta.portrait) {
        nextMeta.portrait = meta.portrait;
      }
      if (variant.data !== "landscape" && meta.landscape) {
        nextMeta.landscape = meta.landscape;
      }

      if (!nextMeta.portrait && !nextMeta.landscape) {
        try {
          await fs.unlink(path.join(dirValidation.resolvedPath, POSTER_META_FILENAME));
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code !== "ENOENT") {
            throw err;
          }
        }
      } else {
        await writePosterMeta(dirValidation.resolvedPath, nextMeta);
      }
    }

    return NextResponse.json({ removed: true, variant: variant.data });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error deleting event poster:", error);
    return NextResponse.json({ error: "Failed to delete poster" }, { status: 500 });
  }
}
