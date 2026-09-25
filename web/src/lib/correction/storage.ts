import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getCorrectionsDir } from "@/lib/config";
import { validatePath } from "@/lib/security/path-validation";

const SHARED_DIR_MODE = 0o2770;
const SHARED_FILE_MODE = 0o660;

/** Bumped when the on-disk pointer contract changes for the Python indexer. */
export const INDEX_POINTER_SCHEMA_VERSION = 2;

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
  /// SHA-256 of that file's bytes. Deliberately not the indexer's own source
  /// fingerprint, which is derived from segment timing and text.
  artifact_sha256: string;
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

/**
 * Create the directory, then check it is somewhere this application is allowed
 * to read from.
 *
 * The check has to come second, because `validatePath` resolves symlinks and
 * so rejects a path that does not exist yet. Doing it at all matters because
 * writes and reads would otherwise disagree: a corrections root outside the
 * allowed directories would accept every write and fail every read, and the
 * failure would surface much later as a missing artifact.
 *
 * The host worker reads this tree as a different user, through the shared
 * group the corrections root carries with its setgid bit. `mkdir`'s mode is
 * masked by the umask and never sets the setgid bit itself, so every level
 * created below the root is chmod'ed explicitly, as the uploads tree does;
 * levels owned by somebody else are left alone.
 */
async function ensureWritableDir(dir: string): Promise<string> {
  // Nothing is created or chmod'ed until the deepest ancestor that already
  // exists has been resolved through its symlinks and found inside the
  // allowed roots. `mkdir` and `chmod` follow directory symlinks, so a link
  // planted under the corrections root could otherwise have directories
  // created, and their modes changed, outside it before the final check.
  const existing = await deepestExistingAncestor(dir);
  requireAllowed(existing);

  await fs.mkdir(dir, { recursive: true, mode: SHARED_DIR_MODE });

  const realRoot = await fs.realpath(getCorrectionsDir()).catch(() => null);
  const relative = path.relative(existing, dir);
  if (realRoot && relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    let current = existing;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      const real = await fs.realpath(current).catch(() => null);
      if (real && (real === realRoot || real.startsWith(realRoot + path.sep))) {
        await fs.chmod(real, SHARED_DIR_MODE).catch(() => undefined);
      }
    }
  }

  return requireAllowed(dir);
}

async function deepestExistingAncestor(dir: string): Promise<string> {
  let current = dir;
  for (;;) {
    try {
      await fs.stat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function requireAllowed(candidate: string): string {
  const result = validatePath(candidate);
  if (!result.valid) {
    throw new Error(
      `Corrections directory is outside the allowed paths: ${candidate} (${result.reason}). ` +
        "Set [paths].corrections_dir inside text_data_dir, or add it to BESEDY_ALLOWED_PATHS."
    );
  }
  return result.resolvedPath;
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
  const dir = await ensureWritableDir(path.dirname(filePath));
  const target = path.join(dir, path.basename(filePath));
  const temporaryPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf-8", mode: SHARED_FILE_MODE });
    // The mode passed to writeFile is masked by the umask too.
    await fs.chmod(temporaryPath, SHARED_FILE_MODE).catch(() => undefined);
    await fs.rename(temporaryPath, target);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Read a file from the corrections tree, or null when it does not exist.
 *
 * Only a missing file is null. A path outside the allowed directories, an
 * unreadable file or malformed JSON throws, because reporting those as
 * "absent" would let a misconfigured corrections root look like an empty one
 * and a corrupt pointer look like no pointer at all.
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const content = await readTextFile(filePath);
  return content === null ? null : (JSON.parse(content) as T);
}

export async function readTextFile(filePath: string): Promise<string | null> {
  // `validatePath` cannot tell a missing path from a forbidden one, so
  // existence is checked first, with lstat so that a symlink counts as
  // present; then the file itself is validated, which resolves that symlink
  // and refuses one that leads outside the allowed roots.
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  const validated = requireValidCorrectionsPath(filePath);
  try {
    return await fs.readFile(validated, "utf-8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
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
