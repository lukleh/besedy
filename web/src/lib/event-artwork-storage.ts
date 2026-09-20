import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import sharp, { type Metadata } from "sharp";
import { getArtworkDir } from "@/lib/config";
import { validatePath } from "@/lib/security/path-validation";

export const ARTWORK_VARIANTS = ["square", "landscape"] as const;
export type ArtworkVariant = (typeof ARTWORK_VARIANTS)[number];
export type ArtworkExtension = ".jpg" | ".png";

export const MAX_ARTWORK_UPLOAD_BYTES = 30 * 1024 * 1024;
export const MAX_ARTWORK_INPUT_PIXELS = 50_000_000;
const ASPECT_RATIO_TOLERANCE = 0.025;
const SHARED_ARTWORK_DIR_MODE = 0o2770;
const SHARED_ARTWORK_FILE_MODE = 0o660;

const TARGETS: Record<ArtworkVariant, { ratio: number; maxWidth: number; maxHeight: number }> = {
  square: { ratio: 1, maxWidth: 1600, maxHeight: 1600 },
  landscape: { ratio: 16 / 9, maxWidth: 2400, maxHeight: 1350 },
};

export interface ArtworkUploadInput {
  bytes: Buffer;
  originalName: string;
}

export interface ProcessedArtworkAsset {
  bytes: Buffer;
  extension: ArtworkExtension;
  mimeType: "image/jpeg" | "image/png";
  originalName: string;
  sha256: string;
  width: number;
  height: number;
}

export interface StagedEventArtworkAssetsRemoval {
  originalPath: string;
  stagedPath: string;
}

export type StagedArtworkCandidateAssetsRemoval = StagedEventArtworkAssetsRemoval;

export class ArtworkAssetError extends Error {
  constructor(
    message: string,
    public readonly code:
      "EMPTY_FILE" | "UPLOAD_TOO_LARGE" | "INVALID_FILE" | "INVALID_FILE_TYPE" | "INVALID_ASPECT_RATIO"
  ) {
    super(message);
    this.name = "ArtworkAssetError";
  }
}

export function resolveEventArtworksPath(catalogId: string): string {
  return path.join(getArtworkDir(), `artwork_${catalogId}`, "events");
}

export function resolveEventArtworkDir(catalogId: string, eventId: number, artworkId: string): string {
  return path.join(resolveEventArtworksPath(catalogId), String(eventId), artworkId);
}

export function resolveEventArtworkAssetPath(
  catalogId: string,
  eventId: number,
  artworkId: string,
  variant: ArtworkVariant,
  extension: ArtworkExtension
): string {
  return path.join(resolveEventArtworkDir(catalogId, eventId, artworkId), `${variant}${extension}`);
}

export function getArtworkContentType(extension: string): string {
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

function assertAspectRatio(variant: ArtworkVariant, width: number, height: number): void {
  if (width <= 0 || height <= 0) {
    throw new ArtworkAssetError("Artwork dimensions are invalid", "INVALID_FILE");
  }
  const target = TARGETS[variant].ratio;
  const relativeDifference = Math.abs(width / height - target) / target;
  if (relativeDifference > ASPECT_RATIO_TOLERANCE) {
    const expected = variant === "square" ? "1:1" : "16:9";
    throw new ArtworkAssetError(
      `${variant === "square" ? "Square" : "Landscape"} artwork must use a ${expected} aspect ratio`,
      "INVALID_ASPECT_RATIO"
    );
  }
}

export async function processArtworkAsset(
  input: ArtworkUploadInput,
  variant: ArtworkVariant
): Promise<ProcessedArtworkAsset> {
  if (input.bytes.length === 0) {
    throw new ArtworkAssetError("Artwork files cannot be empty", "EMPTY_FILE");
  }
  if (input.bytes.length > MAX_ARTWORK_UPLOAD_BYTES) {
    throw new ArtworkAssetError("Artwork upload is too large", "UPLOAD_TOO_LARGE");
  }

  const image = sharp(input.bytes, {
    failOn: "warning",
    limitInputPixels: MAX_ARTWORK_INPUT_PIXELS,
  });

  let metadata: Metadata;
  try {
    metadata = await image.metadata();
  } catch {
    throw new ArtworkAssetError("Artwork contains invalid image data", "INVALID_FILE");
  }

  if (metadata.format !== "jpeg" && metadata.format !== "png") {
    throw new ArtworkAssetError("Artwork files must be JPG or PNG", "INVALID_FILE_TYPE");
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
  let extension: ArtworkExtension;
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
    throw new ArtworkAssetError("Artwork contains invalid image data", "INVALID_FILE");
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

export async function writeArtworkCandidateAssets(options: {
  catalogId: string;
  eventId: number;
  artworkId: string;
  square: ProcessedArtworkAsset;
  landscape: ProcessedArtworkAsset;
}): Promise<string> {
  const eventDir = path.join(resolveEventArtworksPath(options.catalogId), String(options.eventId));
  await fs.mkdir(eventDir, { recursive: true, mode: SHARED_ARTWORK_DIR_MODE });
  const relative = path.relative(getArtworkDir(), eventDir).split(path.sep);
  let current = getArtworkDir();
  for (const segment of relative) {
    current = path.join(current, segment);
    await fs.chmod(current, SHARED_ARTWORK_DIR_MODE).catch(() => undefined);
  }
  const eventValidation = validatePath(eventDir);
  if (!eventValidation.valid) {
    throw new Error("Invalid event artwork directory");
  }

  const finalDir = path.join(eventValidation.resolvedPath, options.artworkId);
  const tempDir = path.join(eventValidation.resolvedPath, `.tmp-${options.artworkId}-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: false, mode: SHARED_ARTWORK_DIR_MODE });
  await fs.chmod(tempDir, SHARED_ARTWORK_DIR_MODE);

  try {
    const squarePath = path.join(tempDir, `square${options.square.extension}`);
    const landscapePath = path.join(tempDir, `landscape${options.landscape.extension}`);
    await Promise.all([
      fs.writeFile(squarePath, options.square.bytes, { flag: "wx", mode: SHARED_ARTWORK_FILE_MODE }),
      fs.writeFile(landscapePath, options.landscape.bytes, { flag: "wx", mode: SHARED_ARTWORK_FILE_MODE }),
    ]);
    await Promise.all([
      fs.chmod(squarePath, SHARED_ARTWORK_FILE_MODE),
      fs.chmod(landscapePath, SHARED_ARTWORK_FILE_MODE),
    ]);
    await fs.rename(tempDir, finalDir);
    return finalDir;
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeArtworkCandidateAssets(catalogId: string, eventId: number, artworkId: string): Promise<void> {
  const candidateDir = resolveEventArtworkDir(catalogId, eventId, artworkId);
  const parentDir = path.dirname(candidateDir);
  try {
    const parentValidation = validatePath(parentDir);
    if (!parentValidation.valid) return;
    const target = path.join(parentValidation.resolvedPath, artworkId);
    await fs.rm(target, { recursive: true, force: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw error;
  }
}

async function stageArtworkDirectoryRemoval(
  originalPath: string,
  tombstoneName: string
): Promise<StagedEventArtworkAssetsRemoval | null> {
  try {
    await fs.lstat(originalPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw error;
  }

  const validation = validatePath(originalPath);
  if (!validation.valid) {
    throw new Error("Invalid event artwork directory");
  }

  const stagedPath = path.join(path.dirname(originalPath), tombstoneName);
  await fs.rename(originalPath, stagedPath);
  return { originalPath, stagedPath };
}

export async function stageArtworkCandidateAssetsRemoval(
  catalogId: string,
  eventId: number,
  artworkId: string
): Promise<StagedArtworkCandidateAssetsRemoval | null> {
  return stageArtworkDirectoryRemoval(
    resolveEventArtworkDir(catalogId, eventId, artworkId),
    `.deleted-${artworkId}-${randomUUID()}`
  );
}

/**
 * Move every artwork asset for an event out of its live path before deleting
 * the event row. The rename stays on the same filesystem and can be rolled
 * back if the database deletion fails.
 */
export async function stageEventArtworkAssetsRemoval(
  catalogId: string,
  eventId: number
): Promise<StagedEventArtworkAssetsRemoval | null> {
  const originalPath = path.join(resolveEventArtworksPath(catalogId), String(eventId));
  return stageArtworkDirectoryRemoval(originalPath, `.deleted-${eventId}-${randomUUID()}`);
}

export async function restoreStagedEventArtworkAssets(staged: StagedEventArtworkAssetsRemoval): Promise<void> {
  try {
    await fs.rename(staged.stagedPath, staged.originalPath);
    return;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EEXIST" && err.code !== "ENOTEMPTY") throw error;
  }

  const stagedEntries = await fs.readdir(staged.stagedPath);
  const liveEntries = new Set(await fs.readdir(staged.originalPath));
  const collision = stagedEntries.find((entry) => liveEntries.has(entry));
  if (collision) {
    throw new Error(`Cannot restore event artwork assets because ${collision} already exists`);
  }
  for (const entry of stagedEntries) {
    await fs.rename(path.join(staged.stagedPath, entry), path.join(staged.originalPath, entry));
  }
  await fs.rmdir(staged.stagedPath);
}

export async function finalizeStagedEventArtworkAssetsRemoval(staged: StagedEventArtworkAssetsRemoval): Promise<void> {
  await fs.rm(staged.stagedPath, { recursive: true, force: true });
}

export async function readArtworkAsset(filePath: string): Promise<{ bytes: Buffer; resolvedPath: string } | null> {
  const validation = validatePath(filePath);
  if (!validation.valid) {
    try {
      await fs.lstat(filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      throw error;
    }
    throw new Error("Artwork asset is missing or outside the artwork root");
  }
  try {
    return {
      bytes: await fs.readFile(validation.resolvedPath),
      resolvedPath: validation.resolvedPath,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw error;
  }
}
