import fs from "fs/promises";
import path from "path";
import { getPostersDir } from "@/lib/config";

export const POSTER_EXTENSIONS = [".jpg", ".jpeg", ".png"] as const;
export type PosterExtension = (typeof POSTER_EXTENSIONS)[number];
export type PosterVariant = "portrait" | "landscape";

export interface PosterFileInfo {
  exists: boolean;
  filename: string | null;
  uploadedAt?: string | null;
  size?: number | null;
}

export interface PosterStatus {
  portrait: boolean;
  landscape: boolean;
}

interface PosterMetaEntry {
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  size: number;
}

interface PosterMeta {
  portrait?: PosterMetaEntry;
  landscape?: PosterMetaEntry;
}

const POSTER_META_FILENAME = "poster_meta.json";

export function resolveEventPostersPath(groupId: string): string {
  return path.join(getPostersDir(), `posters_${groupId}`, "events");
}

export function resolveEventPosterDir(groupId: string, eventId: number): string {
  return path.join(resolveEventPostersPath(groupId), String(eventId));
}

export function getPosterBaseName(variant: PosterVariant): string {
  return `poster_${variant}`;
}

export function getPosterContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

async function readPosterMeta(groupId: string, eventId: number): Promise<PosterMeta | null> {
  const dir = resolveEventPosterDir(groupId, eventId);
  const metaPath = path.join(dir, POSTER_META_FILENAME);
  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as PosterMeta | null;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writePosterMeta(dir: string, meta: PosterMeta): Promise<void> {
  const metaPath = path.join(dir, POSTER_META_FILENAME);
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
}

export async function findPosterFile(
  groupId: string,
  eventId: number,
  variant: PosterVariant
): Promise<string | null> {
  const dir = resolveEventPosterDir(groupId, eventId);
  const base = getPosterBaseName(variant);

  for (const ext of POSTER_EXTENSIONS) {
    const candidate = path.join(dir, `${base}${ext}`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next extension
    }
  }

  return null;
}

export async function getPosterStatus(groupId: string, eventId: number): Promise<PosterStatus> {
  const [portrait, landscape] = await Promise.all([
    findPosterFile(groupId, eventId, "portrait"),
    findPosterFile(groupId, eventId, "landscape"),
  ]);

  return { portrait: !!portrait, landscape: !!landscape };
}

export async function getPosterInfo(
  groupId: string,
  eventId: number
): Promise<{ portrait: PosterFileInfo; landscape: PosterFileInfo }> {
  const [portrait, landscape, meta] = await Promise.all([
    findPosterFile(groupId, eventId, "portrait"),
    findPosterFile(groupId, eventId, "landscape"),
    readPosterMeta(groupId, eventId),
  ]);

  const toInfo = async (
    filePath: string | null,
    key: "portrait" | "landscape"
  ): Promise<PosterFileInfo> => {
    if (!filePath) {
      return { exists: false, filename: null, uploadedAt: null, size: null };
    }
    const metaEntry = meta?.[key];
    let size = metaEntry?.size ?? null;
    if (size === null) {
      try {
        const stat = await fs.stat(filePath);
        size = stat.size;
      } catch {
        size = null;
      }
    }
    return {
      exists: true,
      filename: metaEntry?.originalName ?? null,
      uploadedAt: metaEntry?.uploadedAt ?? null,
      size,
    };
  };

  return {
    portrait: await toInfo(portrait, "portrait"),
    landscape: await toInfo(landscape, "landscape"),
  };
}

export async function removeExistingPosterFiles(
  dir: string,
  variant: PosterVariant
): Promise<void> {
  const base = getPosterBaseName(variant);

  await Promise.all(
    POSTER_EXTENSIONS.map(async (ext) => {
      const filePath = path.join(dir, `${base}${ext}`);
      try {
        await fs.unlink(filePath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw err;
        }
      }
    })
  );
}
