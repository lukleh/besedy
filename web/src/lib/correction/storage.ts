import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getCorrectionsDir } from "@/lib/config";
import { validatePath } from "@/lib/security/path-validation";

const SHARED_DIR_MODE = 0o2770;
const SHARED_FILE_MODE = 0o660;

/** Bumped when the on-disk pointer contract changes for the Python indexer. */
export const INDEX_POINTER_SCHEMA_VERSION = 1;

export type IndexPointerState = "activating" | "active";

/**
 * The pointer the search indexer reads.
 *
 * Database pointers decide what web consumers resolve, but the index build
 * runs in the Python package and has no database. The filesystem is the
 * boundary those two already share, so the effective search source for an
 * audio hash is published here as a small file, exactly as transcripts are
 * published as files today.
 */
export interface CorrectionIndexPointer {
  schema_version: number;
  workflow_group_id: string;
  audio_hash: string;
  workspace_id: string;
  publication_id: string;
  state: IndexPointerState;
  /// Honest backend of the machine source underneath the corrections
  backend: string;
  /// Path to the published transcript.json, relative to the corrections root
  transcript_path: string;
  transcript_fingerprint: string;
  updated_at: string;
}

function requireValidCorrectionsPath(candidate: string): string {
  const result = validatePath(candidate);
  if (!result.valid) {
    throw new Error(`Invalid corrections path: ${result.reason}`);
  }
  return result.resolvedPath;
}

export function resolveCatalogCorrectionsRoot(catalogId: string): string {
  return path.join(getCorrectionsDir(), `corrections_${catalogId}`);
}

export function resolveWorkspaceDir(
  catalogId: string,
  workspaceId: string
): string {
  return path.join(resolveCatalogCorrectionsRoot(catalogId), workspaceId);
}

export function resolveWorkspaceSourcePath(
  catalogId: string,
  workspaceId: string
): string {
  return path.join(resolveWorkspaceDir(catalogId, workspaceId), "source", "transcript.json");
}

export function resolvePublicationDir(
  catalogId: string,
  workspaceId: string,
  publicationId: string
): string {
  return path.join(
    resolveWorkspaceDir(catalogId, workspaceId),
    "publications",
    publicationId
  );
}

export function resolvePublicationFilePath(
  catalogId: string,
  workspaceId: string,
  publicationId: string,
  format: "json" | "txt" | "srt" | "vtt"
): string {
  return path.join(
    resolvePublicationDir(catalogId, workspaceId, publicationId),
    `transcript.${format}`
  );
}

export function resolveIndexPointerDir(catalogId: string): string {
  return path.join(resolveCatalogCorrectionsRoot(catalogId), "index-sources");
}

export function resolveIndexPointerPath(
  catalogId: string,
  audioHash: string
): string {
  return path.join(resolveIndexPointerDir(catalogId), `${audioHash}.json`);
}

/** Path recorded inside the pointer, so a differently mounted reader still resolves it. */
export function relativeToCorrectionsRoot(absolutePath: string): string {
  return path.relative(getCorrectionsDir(), absolutePath).split(path.sep).join("/");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: SHARED_DIR_MODE });
}

/**
 * Write through a temporary file in the same directory, so a reader never
 * observes a half-written artifact and a crashed job leaves nothing partial
 * behind under a name a consumer resolves.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const temporaryPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf-8", mode: SHARED_FILE_MODE });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const validated = requireValidCorrectionsPath(filePath);
    const content = await fs.readFile(validated, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    const validated = requireValidCorrectionsPath(filePath);
    return await fs.readFile(validated, "utf-8");
  } catch {
    return null;
  }
}

export async function writeIndexPointer(
  pointer: CorrectionIndexPointer
): Promise<void> {
  await writeFileAtomic(
    resolveIndexPointerPath(pointer.workflow_group_id, pointer.audio_hash),
    `${JSON.stringify(pointer, null, 2)}\n`
  );
}

export async function readIndexPointer(
  catalogId: string,
  audioHash: string
): Promise<CorrectionIndexPointer | null> {
  return readJsonFile<CorrectionIndexPointer>(
    resolveIndexPointerPath(catalogId, audioHash)
  );
}

/**
 * Remove the pointer. Only the exceptional administrative path that takes
 * corrected text back out of search calls this; an ordinary unpublish moves
 * the reader pointer and deliberately leaves search alone.
 */
export async function removeIndexPointer(
  catalogId: string,
  audioHash: string
): Promise<void> {
  await fs.rm(resolveIndexPointerPath(catalogId, audioHash), { force: true });
}
