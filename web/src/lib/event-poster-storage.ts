import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import sharp, { type Metadata } from "sharp";
import { getPostersDir } from "@/lib/config";
import { validatePath } from "@/lib/security/path-validation";

export const POSTER_VARIANTS = ["square", "landscape"] as const;
export type PosterVariant = (typeof POSTER_VARIANTS)[number];
export type PosterExtension = ".jpg" | ".png";

export const MAX_POSTER_UPLOAD_BYTES = 30 * 1024 * 1024;
export const MAX_POSTER_INPUT_PIXELS = 50_000_000;
const ASPECT_RATIO_TOLERANCE = 0.025;

const TARGETS: Record<PosterVariant, { ratio: number; maxWidth: number; maxHeight: number }> = {
  square: { ratio: 1, maxWidth: 1600, maxHeight: 1600 },
  landscape: { ratio: 16 / 9, maxWidth: 2400, maxHeight: 1350 },
};

export interface PosterUploadInput {
  bytes: Buffer;
  originalName: string;
}

export interface ProcessedPosterAsset {
  bytes: Buffer;
  extension: PosterExtension;
  mimeType: "image/jpeg" | "image/png";
  originalName: string;
  sha256: string;
  width: number;
  height: number;
}

export class PosterAssetError extends Error {
  constructor(
    message: string,
    public readonly code:
      "EMPTY_FILE" | "UPLOAD_TOO_LARGE" | "INVALID_FILE" | "INVALID_FILE_TYPE" | "INVALID_ASPECT_RATIO"
  ) {
    super(message);
    this.name = "PosterAssetError";
  }
}

export function resolveEventPostersPath(catalogId: string): string {
  return path.join(getPostersDir(), `posters_${catalogId}`, "events");
}

export function resolveEventPosterDir(catalogId: string, eventId: number, posterId: string): string {
  return path.join(resolveEventPostersPath(catalogId), String(eventId), posterId);
}

export function resolveEventPosterAssetPath(
  catalogId: string,
  eventId: number,
  posterId: string,
  variant: PosterVariant,
  extension: PosterExtension
): string {
  return path.join(resolveEventPosterDir(catalogId, eventId, posterId), `${variant}${extension}`);
}

export function getPosterContentType(extension: string): string {
  return extension === ".png" ? "image/png" : "image/jpeg";
}

function effectiveDimensions(metadata: Metadata): {
  width: number;
  height: number;
} {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
  return swapsAxes ? { width: height, height: width } : { width, height };
}

function assertAspectRatio(variant: PosterVariant, width: number, height: number): void {
  if (width <= 0 || height <= 0) {
    throw new PosterAssetError("Poster dimensions are invalid", "INVALID_FILE");
  }
  const target = TARGETS[variant].ratio;
  const relativeDifference = Math.abs(width / height - target) / target;
  if (relativeDifference > ASPECT_RATIO_TOLERANCE) {
    const expected = variant === "square" ? "1:1" : "16:9";
    throw new PosterAssetError(
      `${variant === "square" ? "Square" : "Landscape"} poster must use a ${expected} aspect ratio`,
      "INVALID_ASPECT_RATIO"
    );
  }
}

export async function processPosterAsset(
  input: PosterUploadInput,
  variant: PosterVariant
): Promise<ProcessedPosterAsset> {
  if (input.bytes.length === 0) {
    throw new PosterAssetError("Poster files cannot be empty", "EMPTY_FILE");
  }
  if (input.bytes.length > MAX_POSTER_UPLOAD_BYTES) {
    throw new PosterAssetError("Poster upload is too large", "UPLOAD_TOO_LARGE");
  }

  const image = sharp(input.bytes, {
    failOn: "warning",
    limitInputPixels: MAX_POSTER_INPUT_PIXELS,
  });

  let metadata: Metadata;
  try {
    metadata = await image.metadata();
  } catch {
    throw new PosterAssetError("Poster contains invalid image data", "INVALID_FILE");
  }

  if (metadata.format !== "jpeg" && metadata.format !== "png") {
    throw new PosterAssetError("Poster files must be JPG or PNG", "INVALID_FILE_TYPE");
  }

  const dimensions = effectiveDimensions(metadata);
  assertAspectRatio(variant, dimensions.width, dimensions.height);

  const target = TARGETS[variant];
  const pipeline = image.rotate().resize({
    width: target.maxWidth,
    height: target.maxHeight,
    fit: "inside",
    withoutEnlargement: true,
  });

  let bytes: Buffer;
  let extension: PosterExtension;
  let mimeType: "image/jpeg" | "image/png";
  try {
    if (metadata.format === "png") {
      bytes = await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
      extension = ".png";
      mimeType = "image/png";
    } else {
      bytes = await pipeline.jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: "4:2:0" }).toBuffer();
      extension = ".jpg";
      mimeType = "image/jpeg";
    }
  } catch {
    throw new PosterAssetError("Poster contains invalid image data", "INVALID_FILE");
  }

  const outputMetadata = await sharp(bytes).metadata();
  return {
    bytes,
    extension,
    mimeType,
    originalName: path.basename(input.originalName).slice(0, 255),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: outputMetadata.width ?? dimensions.width,
    height: outputMetadata.height ?? dimensions.height,
  };
}

export async function writePosterCandidateAssets(options: {
  catalogId: string;
  eventId: number;
  posterId: string;
  square: ProcessedPosterAsset;
  landscape: ProcessedPosterAsset;
}): Promise<string> {
  const eventDir = path.join(resolveEventPostersPath(options.catalogId), String(options.eventId));
  await fs.mkdir(eventDir, { recursive: true });
  const eventValidation = validatePath(eventDir);
  if (!eventValidation.valid) {
    throw new Error("Invalid event poster directory");
  }

  const finalDir = path.join(eventValidation.resolvedPath, options.posterId);
  const tempDir = path.join(eventValidation.resolvedPath, `.tmp-${options.posterId}-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: false });

  try {
    await fs.writeFile(path.join(tempDir, `square${options.square.extension}`), options.square.bytes, { flag: "wx" });
    await fs.writeFile(path.join(tempDir, `landscape${options.landscape.extension}`), options.landscape.bytes, {
      flag: "wx",
    });
    await fs.rename(tempDir, finalDir);
    return finalDir;
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removePosterCandidateAssets(catalogId: string, eventId: number, posterId: string): Promise<void> {
  const candidateDir = resolveEventPosterDir(catalogId, eventId, posterId);
  const parentDir = path.dirname(candidateDir);
  try {
    const parentValidation = validatePath(parentDir);
    if (!parentValidation.valid) return;
    const target = path.join(parentValidation.resolvedPath, posterId);
    await fs.rm(target, { recursive: true, force: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw error;
  }
}

export async function readPosterAsset(filePath: string): Promise<{ bytes: Buffer; resolvedPath: string }> {
  const validation = validatePath(filePath);
  if (!validation.valid) {
    throw new Error("Poster asset is missing or outside the poster root");
  }
  return {
    bytes: await fs.readFile(validation.resolvedPath),
    resolvedPath: validation.resolvedPath,
  };
}
